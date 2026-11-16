"""Fly ArduCopter SITL through scenarios and keep the dataflash .bin and a .tlog of each.

usage: python3 genlogs.py <out_dir> <ap_root> <instance> <scenario> [<scenario> ...]
"""
import os, sys, time, subprocess, signal, shutil, glob, math
from pymavlink import mavutil

OUT, AP, INST = sys.argv[1], sys.argv[2], int(sys.argv[3])
SCENARIOS = sys.argv[4:]
BIN = f"{AP}/build/sitl/bin/arducopter"
DEFAULTS = f"{AP}/Tools/autotest/default_params/copter.parm"
HOME = (23.0225, 72.5714, 53, 0)
SPEEDUP = 5
IS47 = "/ap/" in AP + "/" or AP.rstrip("/").endswith("/ap/ardupilot")


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


class Run:
    def __init__(self, name):
        self.name = name
        self.dir = os.path.join(OUT, name)
        shutil.rmtree(self.dir, ignore_errors=True)
        os.makedirs(self.dir)
        args = [BIN, "--model", "quad", "--speedup", str(SPEEDUP), "--home", ",".join(map(str, HOME)), f"-I{INST}", "--wipe", "--defaults", DEFAULTS]
        self.p = subprocess.Popen(args, cwd=self.dir, stdout=open(os.path.join(self.dir, "sitl.out"), "w"), stderr=subprocess.STDOUT)
        time.sleep(1.5)
        self.m = mavutil.mavlink_connection(f"tcp:127.0.0.1:{5760 + 10 * INST}", source_system=255, retries=60)
        self.m.setup_logfile(os.path.join(self.dir, f"{name}.tlog"))
        self.m.wait_heartbeat(timeout=60)
        self.m.mav.request_data_stream_send(self.m.target_system, self.m.target_component, mavutil.mavlink.MAV_DATA_STREAM_ALL, 10, 1)

    def hb(self):
        self.m.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_GCS, mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)

    def pump(self, secs, cond=None):
        """Read messages for `secs` sim-aware wall seconds, sending GCS heartbeats; stop early if cond(msg) is true."""
        end = time.time() + secs
        last = 0
        while time.time() < end:
            if time.time() - last > 0.5:
                self.hb(); last = time.time()
            m = self.m.recv_match(blocking=True, timeout=0.2)
            if m is None:
                continue
            if m.get_type() == "STATUSTEXT":
                log(self.name, "STATUSTEXT:", m.text)
            if cond and cond(m):
                return m
        return None

    def param(self, name, value):
        for _ in range(5):
            self.m.mav.param_set_send(self.m.target_system, self.m.target_component, name.encode(), float(value), mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
            got = self.pump(3, lambda m: m.get_type() == "PARAM_VALUE" and m.param_id == name)
            if got and abs(got.param_value - value) < 1e-3 * max(1, abs(value)):
                return
        raise RuntimeError(f"param {name} not set")

    def mode(self, name):
        mid = self.m.mode_mapping()[name]
        for _ in range(10):
            self.m.mav.command_long_send(self.m.target_system, self.m.target_component, mavutil.mavlink.MAV_CMD_DO_SET_MODE, 0, 1, mid, 0, 0, 0, 0, 0)
            if self.pump(2, lambda m: m.get_type() == "HEARTBEAT" and m.custom_mode == mid and m.type != 6):
                return
        raise RuntimeError("mode " + name)

    def armed(self):
        return self.m.motors_armed()

    def wait_ready(self):
        log(self.name, "waiting for pre-arm")
        t0 = time.time()
        while time.time() - t0 < 180:
            m = self.pump(1, lambda m: m.get_type() == "SYS_STATUS")
            if m and (m.onboard_control_sensors_health & 0x10000000):
                ekf = self.pump(2, lambda x: x.get_type() == "EKF_STATUS_REPORT")
                if ekf and (ekf.flags & 0x10) and (ekf.flags & 0x08):
                    self.pump(8)  # let the EKF settle on GPS
                    return
        raise RuntimeError("never ready")

    def arm_takeoff(self, alt):
        self.mode("GUIDED")
        for _ in range(10):
            self.m.mav.command_long_send(self.m.target_system, self.m.target_component, mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0, 1, 0, 0, 0, 0, 0, 0)
            # SPEEDUP makes wall seconds worth several sim seconds: take off at once, before the auto-disarm.
            self.pump(1, lambda m: m.get_type() == "HEARTBEAT" and m.type != 6 and (m.base_mode & 128))
            if self.armed():
                break
        if not self.armed():
            raise RuntimeError("would not arm")
        self.m.mav.command_long_send(self.m.target_system, self.m.target_component, mavutil.mavlink.MAV_CMD_NAV_TAKEOFF, 0, 0, 0, 0, 0, 0, 0, alt)
        ack = self.pump(3, lambda m: m.get_type() == "COMMAND_ACK" and m.command == mavutil.mavlink.MAV_CMD_NAV_TAKEOFF)
        log(self.name, "takeoff ack", ack.result if ack else None)
        got = self.pump(60, lambda m: m.get_type() == "GLOBAL_POSITION_INT" and m.relative_alt > (alt - 1) * 1000)
        if not got:
            raise RuntimeError("did not climb")
        log(self.name, "airborne at", alt)

    def goto(self, north, east, alt, secs):
        lat = HOME[0] + north / 111320.0
        lon = HOME[1] + east / (111320.0 * math.cos(math.radians(HOME[0])))
        self.m.mav.set_position_target_global_int_send(0, self.m.target_system, self.m.target_component, mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, 0b110111111000, int(lat * 1e7), int(lon * 1e7), alt, 0, 0, 0, 0, 0, 0, 0, 0)
        self.pump(secs)

    def land_and_wait(self, mode="LAND", secs=120):
        self.mode(mode)
        t0 = time.time()
        while time.time() - t0 < secs and self.armed():
            self.pump(1)
        log(self.name, "disarmed" if not self.armed() else "STILL ARMED")

    def finish(self, kill=False):
        if kill:
            self.p.send_signal(signal.SIGKILL)
        else:
            self.pump(3)
            self.p.terminate()
        self.p.wait(10)
        self.m.close()
        bins = sorted(glob.glob(os.path.join(self.dir, "logs", "*.BIN")), key=os.path.getmtime)
        for b in bins:
            log(self.name, "log", b, os.path.getsize(b))
        if bins:
            shutil.copy(bins[-1], os.path.join(self.dir, f"{self.name}.bin"))


def scenario(name):
    r = Run(name)
    try:
        r.wait_ready()
        r.param("LOG_DISARMED", 0)
        if name.startswith("normal"):
            r.arm_takeoff(15)
            r.goto(40, 0, 20, 12)
            r.goto(40, 40, 20, 12)
            r.pump(5)
            r.land_and_wait("RTL", 150)
        elif name == "vibration":
            # Accel noise only shows with a vibration frequency set (SITL adds it as sine waves).
            r.param("SIM_ACC1_RND", 45); r.param("SIM_ACC2_RND", 45)
            r.param("SIM_VIB_FREQ_X", 23); r.param("SIM_VIB_FREQ_Y", 27); r.param("SIM_VIB_FREQ_Z", 31)
            r.arm_takeoff(10)
            r.goto(30, 0, 12, 15)
            r.land_and_wait("LAND")
        elif name == "clipping":
            r.arm_takeoff(8)
            # Past the IMU's 16 g range, briefly.
            r.param("SIM_VIB_FREQ_X", 23); r.param("SIM_VIB_FREQ_Y", 27); r.param("SIM_VIB_FREQ_Z", 31)
            r.param("SIM_ACC1_RND", 170); r.param("SIM_ACC2_RND", 170)
            r.pump(2)
            r.param("SIM_ACC1_RND", 0); r.param("SIM_ACC2_RND", 0)
            r.pump(8)
            r.land_and_wait("LAND")
        elif name == "motorfail":
            r.arm_takeoff(20)
            r.goto(20, 0, 20, 8)
            r.param("SIM_ENGINE_FAIL", 1 if IS47 else 0)  # 4.7: a mask of motors; 4.6: a motor index
            r.param("SIM_ENGINE_MUL", 0)
            log(name, "motor 1 cut")
            r.pump(30)
        elif name == "gpsloss":
            r.arm_takeoff(15)
            r.pump(5)
            if IS47:
                r.param("SIM_GPS1_ENABLE", 0)
            else:
                r.param("SIM_GPS_DISABLE", 1)
            log(name, "GPS off")
            r.pump(40)
            r.land_and_wait("LAND", 120)
        elif name == "battery":
            # Capacity-based: fails over after ~250 mAh are used, whatever the voltage model does.
            r.param("BATT_CAPACITY", 3300); r.param("BATT_LOW_MAH", 3050); r.param("BATT_FS_LOW_ACT", 2)
            r.arm_takeoff(15)
            r.goto(30, 30, 15, 5)
            r.pump(240, lambda m: m.get_type() == "HEARTBEAT" and m.type != 6 and m.custom_mode == 6)  # RTL
            r.land_and_wait("RTL", 150)
        elif name == "compass":
            r.param("SIM_MAG1_MOT_X" if False else "SIM_MAG_MOT_X", 80); r.param("SIM_MAG_MOT_Y", 60); r.param("SIM_MAG_MOT_Z", -90)
            r.arm_takeoff(12)
            r.goto(30, 0, 15, 12)
            r.land_and_wait("LAND")
        elif name == "brownout":
            r.arm_takeoff(25)
            r.goto(30, 0, 25, 10)
            log(name, "killing SITL in the air")
            r.finish(kill=True)
            return
        r.finish()
    except Exception as e:
        log(name, "FAILED", e)
        try:
            r.finish(kill=True)
        except Exception:
            pass


for s in SCENARIOS:
    log("=== scenario", s)
    scenario(s)
