/*
  How to install firmware: what you need, the steps, which build a board
  needs, what happens to its settings, and what to do when it does not work.
*/
import { CircleAlert, Download, ExternalLink } from "lucide-react";

const DOCS = "https://ardupilot.org/copter/docs";

export function Guide({ onInstall }: { onInstall: () => void }) {
  return (
    <article className="fw-guide">
      <section>
        <h2>What firmware is, and why only stable</h2>
        <p>
          The firmware is the program the flight controller runs: ArduPilot's ArduCopter for multicopters and helicopters. A new board may come with no firmware, with PX4, or with an old ArduPilot version. Installing writes the new program over the old one through the board's <em>bootloader</em>, a small program at the start of the flash that is never erased, so a failed install can always be done again.
        </p>
        <p>
          AERONEX offers only <strong>stable</strong> releases: the versions ArduPilot has run through beta testing and released for flying. Beta and development builds change every day and are for testers. If you need one, you can download it and install it from a file under Advanced.
        </p>
      </section>

      <section>
        <h2>Before you start</h2>
        <ul className="fw-check">
          <li>
            <strong>Chrome or Edge on a computer.</strong> The browser talks to the board over Web Serial, which phones, tablets, Safari and Firefox do not have.
          </li>
          <li>
            <strong>A USB data cable</strong> into the flight controller's own USB port. Many cables only charge; if the board does not show up, try another cable. Plug it straight into the computer, not through a hub or dock.
          </li>
          <li>
            <strong>Propellers off, battery unplugged.</strong> USB powers the board while it installs. A board that restarts into new firmware with a battery and props attached is a risk you do not need.
          </li>
          <li>
            <strong>Nothing else using the board.</strong> Close Mission Planner, QGroundControl and MAVProxy, which keep the port open.
          </li>
          <li>
            <strong>Save the parameters</strong> if the board already flies: <em>Parameters → Save file</em>. They normally survive an upgrade, but a copy costs nothing.
          </li>
        </ul>
      </section>

      <section>
        <h2>Installing, step by step</h2>
        <ol className="fw-steps fw-steps-guide">
          <li>
            <strong>Choose what it flies:</strong> multicopter or helicopter.
          </li>
          <li>
            <strong>Get the board into its bootloader.</strong>
            <ul>
              <li>
                If AERONEX is already connected to it over USB, click <em>Restart into bootloader</em>.
              </li>
              <li>
                Otherwise unplug the USB cable, click <em>Find the board</em>, plug the cable in and choose the board in the list that opens. If it shows a name like <em>ArduPilot</em> or <em>Pixhawk</em>, it is running firmware: AERONEX asks it to restart into its bootloader.
              </li>
              <li>
                The bootloader appears as a separate USB device (often with “BL” or “bootloader” in its name). The first time, choose it in the list too; Chrome then remembers it and AERONEX opens it by itself next time. After a restart from AERONEX it waits as long as you need.
              </li>
            </ul>
          </li>
          <li>
            <strong>Check the build.</strong> AERONEX reads the board id, flash size and processor from the bootloader and picks the ArduPilot build made for that board. It downloads the latest stable release and checks that it fits: the right board, small enough for the flash.
          </li>
          <li>
            <strong>Install.</strong> The board erases the old firmware (about 10 seconds), takes the new one and reports a checksum of its whole flash, which must match the file's exactly. Only then is it told to start. About half a minute in all.
          </li>
          <li>
            <strong>Connect and check.</strong> After a few seconds, connect on the Connection page. The version shows in the link's messages. For a new install, set the frame type and calibrate again.
          </li>
        </ol>
        <button className="btn btn-primary" onClick={onInstall}>
          <Download size={15} /> Go to Install
        </button>
      </section>

      <section>
        <h2>Which build does my board need?</h2>
        <p>AERONEX picks it, but it helps to know why:</p>
        <dl className="fw-defs">
          <dt>Pixhawk 2.4.8 and other Pixhawk 1 clones</dt>
          <dd>
            Use <strong>Pixhawk1</strong> or <strong>Pixhawk1-1M</strong>. Many of these boards have an early STM32F427 processor that can only use 1 MB of its 2 MB flash. On those, only the 1M build works; it leaves out some features to fit. AERONEX asks the bootloader for the processor's revision and chooses. A bootloader too old to say gets the 1M build, which runs on every board of this type; if the board then reports “2M flash - use Pixhawk1 firmware”, install the Pixhawk1 build from the list of other builds.
          </dd>
          <dt>Cube (Black, Orange, Purple…)</dt>
          <dd>Cube bootloaders have their own USB id, which tells AERONEX the exact model even where several share a board id.</dd>
          <dt>Names ending in -bdshot</dt>
          <dd>The same board with bi-directional DShot, for ESCs that send RPM back over the signal wire (BLHeli32, AM32, Bluejay). Use it only if your ESCs support it.</dd>
          <dt>Names with SimOnHardWare</dt>
          <dd>Run the simulator on the board for bench tests. They cannot fly, and AERONEX never picks them.</dd>
        </dl>
      </section>

      <section>
        <h2>What happens to the settings</h2>
        <p>
          Parameters are stored apart from the firmware, so upgrading keeps them: calibration, frame, failsafes and tuning carry over. ArduPilot converts any that a new version renamed. Going from PX4 to ArduPilot, or between vehicle types, starts with defaults. A very old version upgraded to a much newer one is worth checking afterwards: compare against your saved file on the Parameters page.
        </p>
      </section>

      <section>
        <h2>When it does not work</h2>
        <dl className="fw-defs">
          <dt>The board is not in the list</dt>
          <dd>
            Try another cable (charge-only cables are common) and another USB port, without a hub. On <strong>Linux</strong>, your user must be in the <code>dialout</code> group (<code>sudo usermod -aG dialout $USER</code>, then log out and in), and ModemManager can grab the board for a few seconds as it appears: stop it with <code>sudo systemctl stop ModemManager</code>. <strong>Windows 10 and 11</strong> and <strong>macOS</strong> need no drivers.
          </dd>
          <dt>“That port is already open”</dt>
          <dd>Another program, or AERONEX's own connection, has the board. Disconnect there first.</dd>
          <dt>It restarted, but the bootloader never connected</dt>
          <dd>
            Click <em>Choose the bootloader</em> and pick the entry with “BL” or “bootloader” in its name. If nothing is listed, unplug the board, click <em>Find the board</em>, plug it in and choose it within a second or two: on a normal power-up the bootloader waits only briefly before starting the firmware.
          </dd>
          <dt>It stopped halfway, or verification failed</dt>
          <dd>
            Nothing is lost. The bootloader is never touched, and a board with incomplete firmware stays in its bootloader. Unplug it, plug it back in and install again. If verification fails twice, change the cable.
          </dd>
          <dt>“Not a stable release” or no stable build for the board</dt>
          <dd>Some new or rare boards have no stable release yet. Download a build from the firmware server and install it from a file, knowing it has had less testing.</dd>
          <dt>Download blocked</dt>
          <dd>
            AERONEX downloads through its own server when run with <code>npm run dev</code> or <code>npm run preview</code>. Hosted elsewhere, the browser may not be allowed to fetch from the firmware server directly: AERONEX then links to the file, which you download and install from a file.
          </dd>
          <dt>The board never shows up at all</dt>
          <dd>
            Boards sold for Betaflight or INAV, and blank boards, may have no ArduPilot-compatible bootloader. Those are loaded once over DFU (hold the BOOT button while plugging in) with the <em>_with_bl.hex</em> file; after that AERONEX can install updates.{" "}
            <a href={`${DOCS}/common-loading-firmware-onto-chibios-only-boards.html`} target="_blank" rel="noreferrer">
              ArduPilot's DFU guide <ExternalLink size={12} />
            </a>
          </dd>
        </dl>
        <div className="callout warn">
          <CircleAlert size={16} />
          <span>
            Firmware is installed only through the flight controller's own USB port. A telemetry radio or a USB-serial adapter on a TELEM port cannot reach the bootloader.
          </span>
        </div>
      </section>

      <section className="fw-more">
        <h2>Read more</h2>
        <ul>
          <li>
            <a href={`${DOCS}/common-loading-firmware-onto-pixhawk.html`} target="_blank" rel="noreferrer">
              Loading firmware (ArduPilot) <ExternalLink size={12} />
            </a>
          </li>
          <li>
            <a href={`${DOCS}/common-bootloader-update.html`} target="_blank" rel="noreferrer">
              Updating the bootloader (ArduPilot) <ExternalLink size={12} />
            </a>
          </li>
          <li>
            <a href="https://firmware.ardupilot.org/Copter/stable/" target="_blank" rel="noreferrer">
              Stable ArduCopter builds on the firmware server <ExternalLink size={12} />
            </a>
          </li>
        </ul>
      </section>
    </article>
  );
}
