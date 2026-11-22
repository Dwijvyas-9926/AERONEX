# Changelog

What changed in each release of AERONEX for Windows. Installed copies update themselves; every
release is on [GitHub](https://github.com/Dwijvyas-9926/AERONEX/releases).

## 0.3.5, 22 November 2026

- Flight instruments: headings near north read 000°, never 360°; climb rates never read -0.0;
  speed and height show one decimal; the height tape continues below the take-off point; the
  vertical speed shows its unit.
- Keyboard Flight no longer says "On ground" while an aircraft armed from another page is in the
  air, and explains why the keys are inactive.
- The Digital Twin's live view says whether it shows the virtual aircraft or a flight controller.
- My location on the maps works in the Windows app, using the Windows location service, only when
  pressed. The app refuses every other permission (camera, microphone, notifications and more).
- A Contact and feedback section on the About page, and Help menu items for the website, sending
  feedback and reporting a problem on GitHub. The project's email is aeronexstation@gmail.com.
- Email links open your mail app; before, the Windows app ignored them.

## 0.3.4, 21 November 2026

- The About page has a fuller creator section: Dwij Vyas's photo, his engineering background at
  Birla Vishvakarma Mahavidyalaya (BVM), Vallabh Vidyanagar, how AERONEX started, and links to his
  GitHub and email.
- Releases are now published in a way that is ready for code signing.

## 0.3.3, 21 November 2026

- Installing firmware works in the Windows app: downloads from ArduPilot's firmware server pass
  through AERONEX itself.
- The About page, the guide, the assistant and other pages describe the Windows app correctly.
- Fixed the assistant's instructions, which wrongly listed flight logs and firmware installing as
  things AERONEX cannot do.

## 0.3.2, 21 November 2026

- AERONEX's home on GitHub is now github.com/Dwijvyas-9926/AERONEX. Updates come from there.

## 0.3.1, 21 November 2026

- AERONEX is open source under the Apache License 2.0, copyright Dwij Vyas. The installer shows
  the licence, and the About page says what it covers.
- The install folder holds LICENSE.txt, NOTICE.txt and THIRD-PARTY-NOTICES.txt.

## 0.3.0, 21 November 2026

- First-run setup: AERONEX asks for your name and describes your first aircraft. It is kept on
  this computer only.
- New installs no longer start with an aircraft named "Avion".
- Settings has a "You" section for your name and team.
- Reset app data also removes API keys kept encrypted by Windows, and is refused while a flight
  controller is connected.

## 0.2.1, 21 November 2026

- The About page shows which version is installed.
- The first update delivered by AERONEX's own updater.

## 0.2.0, 21 November 2026

- AERONEX keeps itself up to date: it looks for a new version when it starts and every few hours,
  downloads it in the background, and offers "Restart now" or "Later".
- It never restarts while a flight controller is connected or firmware is being installed.
- Settings → Updates and Help → Check for updates show the version and look for a new one.
