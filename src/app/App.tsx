import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect } from "react";
import { HashRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { BrandLockup } from "../components/shell/BrandMark";
import { startHomeFollow } from "../services/link/homeFollow";
import { ErrorBoundary } from "../components/shell/ErrorBoundary";
import { HelpPanel } from "../components/shell/HelpPanel";
import { AssistantPanel } from "../features/assistant/AssistantPanel";
import { SearchPalette } from "../components/shell/SearchPalette";
import { ConfirmDialog, Toasts } from "../components/shell/Overlays";
import { Sidebar } from "../components/shell/Sidebar";
import { StatusBar } from "../components/shell/StatusBar";
import { VirtualDataBanner } from "../components/shell/VirtualDataBanner";
import { OverviewPage } from "../features/overview/OverviewPage";
import { prefersReducedMotion, useSettings } from "../state/settingsStore";
import { useLinkNotifications } from "./useLinkNotifications";
import { useLink } from "../state/linkStore";
import { commandLink } from "../services/link/commandLink";
import { routeFor } from "./routes";
import { useUi } from "../state/uiStore";

// Flight Logs is large (charts, the reader, the replay) and only needed when opened.
// Each page is fetched when it is first opened, so the first screen does not wait for all twenty. The offline copy holds every one.
const AboutPage = lazy(() => import("../features/about/AboutPage").then((m) => ({ default: m.AboutPage })));
const CalibrationPage = lazy(() => import("../features/calibration/CalibrationPage").then((m) => ({ default: m.CalibrationPage })));
const ConnectionPage = lazy(() => import("../features/connection/ConnectionPage").then((m) => ({ default: m.ConnectionPage })));
const DigitalTwinPage = lazy(() => import("../features/digital-twin/DigitalTwinPage").then((m) => ({ default: m.DigitalTwinPage })));
const DoctorPage = lazy(() => import("../features/doctor/DoctorPage").then((m) => ({ default: m.DoctorPage })));
const FlightDataPage = lazy(() => import("../features/flightdata/FlightDataPage").then((m) => ({ default: m.FlightDataPage })));
const FrameStudioPage = lazy(() => import("../features/frame-studio/FrameStudioPage").then((m) => ({ default: m.FrameStudioPage })));
const MissionPlanningPage = lazy(() => import("../features/mission-planning/MissionPlanningPage").then((m) => ({ default: m.MissionPlanningPage })));
const FullParamsPage = lazy(() => import("../features/params/FullParamsPage").then((m) => ({ default: m.FullParamsPage })));
const KeyboardFlightPage = lazy(() => import("../features/keyboard-flight/KeyboardFlightPage").then((m) => ({ default: m.KeyboardFlightPage })));
const PidTuningPage = lazy(() => import("../features/pid/PidTuningPage").then((m) => ({ default: m.PidTuningPage })));
const PreflightPage = lazy(() => import("../features/preflight/PreflightPage").then((m) => ({ default: m.PreflightPage })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const SimulatorPage = lazy(() => import("../features/simulator/SimulatorPage").then((m) => ({ default: m.SimulatorPage })));
const TelemetryPage = lazy(() => import("../features/telemetry/TelemetryPage").then((m) => ({ default: m.TelemetryPage })));
const VehicleConfigPage = lazy(() => import("../features/vehicle-config/VehicleConfigPage").then((m) => ({ default: m.VehicleConfigPage })));
const ServoPage = lazy(() => import("../features/servo/ServoPage").then((m) => ({ default: m.ServoPage })));
const FirmwarePage = lazy(() => import("../features/firmware/FirmwarePage").then((m) => ({ default: m.FirmwarePage })));
const LogsPage = lazy(() => import("../features/logs/LogsPage").then((m) => ({ default: m.LogsPage })));

/* Stream a 1 Hz GCS heartbeat whenever a vehicle is connected, so ArduPilot's
   GCS failsafe is armed. It stops when the tab closes or the link drops, which
   is what triggers the vehicle to land on its own. */
function useGcsHeartbeat() {
  const status = useLink((s) => s.status);
  // Home follows a linked aircraft's GPS, whichever page is open.
  useEffect(() => startHomeFollow(), []);

  useEffect(() => {
    if (status === "connected") {
      commandLink.startHeartbeat();
      return () => commandLink.stopHeartbeat();
    }
  }, [status]);
}

function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        className="page"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      >
        <ErrorBoundary page={location.pathname}>
        <Suspense fallback={<div className="page-pad" role="status">Loading…</div>}>
        <Routes location={location}>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/connection" element={<ConnectionPage />} />
          <Route path="/digital-twin" element={<DigitalTwinPage />} />
          <Route path="/frame-studio" element={<FrameStudioPage />} />
          <Route path="/firmware" element={<Suspense fallback={<div className="page-pad">Loading Firmware…</div>}><FirmwarePage /></Suspense>} />
          <Route path="/calibration" element={<CalibrationPage />} />
          <Route path="/doctor" element={<DoctorPage />} />
          <Route path="/vehicle" element={<VehicleConfigPage />} />
          <Route path="/servo" element={<Suspense fallback={<div className="page-pad">Loading Servo Outputs…</div>}><ServoPage /></Suspense>} />
          <Route path="/pid" element={<PidTuningPage />} />
          <Route path="/params" element={<FullParamsPage />} />
          <Route path="/preflight" element={<PreflightPage />} />
          <Route path="/flight-data" element={<FlightDataPage />} />
          <Route path="/simulator" element={<SimulatorPage />} />
          <Route path="/keyboard-flight" element={<KeyboardFlightPage />} />
          <Route path="/missions" element={<MissionPlanningPage />} />
          <Route path="/telemetry" element={<TelemetryPage />} />
          <Route path="/logs" element={<Suspense fallback={<div className="page-pad">Loading Flight Logs…</div>}><LogsPage /></Suspense>} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<OverviewPage />} />
        </Routes>
        </Suspense>
        </ErrorBoundary>
      </motion.div>
    </AnimatePresence>
  );
}

/* The tab says which page it is on, so several open tabs can be told apart. */
function usePageTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    const r = routeFor(pathname);
    document.title = r.path === "/" ? "AERONEX Ground Station" : `${r.label} – AERONEX`;
  }, [pathname]);
}

/*
  App-wide keys: Ctrl or ⌘ K to search, Ctrl or ⌘ J for the assistant, ? for
  the guide. The ? is ignored while typing in a field, where it is just a
  question mark. None of them is a Keyboard Flight key, and that page ignores
  any key pressed with Ctrl or ⌘.
*/
function useGlobalKeys() {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUi.getState().toggle("search");
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        useUi.getState().toggle("assistant");
      } else if (e.key === "?" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        useUi.getState().toggle("help");
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
}

function Frame() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const help = useUi((s) => s.overlay === "help" || s.overlay === "assistant");
  const wide = useUi((s) => s.overlay === "assistant");
  const nav = useNavigate();
  useLinkNotifications();
  useGcsHeartbeat();
  usePageTitle();
  useGlobalKeys();
  return (
    <div className="app" data-collapsed={collapsed} data-help={help} data-assistant={wide}>
      <a className="skip-link" href="#main">
        Skip to the page
      </a>
      <button className="brand" onClick={() => nav("/")} title="AERONEX Ground Station — Overview">
        <BrandLockup />
      </button>
      <StatusBar />
      <Sidebar />
      <main className="main" id="main">
        <VirtualDataBanner />
        <AnimatedRoutes />
      </main>
      <HelpPanel />
      <AssistantPanel />
      <SearchPalette />
      <Toasts />
      <ConfirmDialog />
    </div>
  );
}

export default function App() {
  const motionPref = useSettings((s) => s.motion);
  const reduced = prefersReducedMotion(motionPref);
  useEffect(() => {
    document.documentElement.dataset.motion = reduced ? "reduced" : "full";
  }, [reduced]);
  return (
    <MotionConfig reducedMotion={reduced ? "always" : "never"}>
      <HashRouter>
        <Frame />
      </HashRouter>
    </MotionConfig>
  );
}
