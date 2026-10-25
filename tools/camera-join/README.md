# MacBook camera join

An experimental, local companion for DistBugs. Python detects printed **ArUco DICT_4X4_50** markers, measures the two screens on a calibrated plane, and streams geometry to the iPhones. Both phones still connect through Multipeer for bug transfer; the webcam replaces the swipe used to locate the screens. The camera sends coordinates, never video. There is no cloud service.

## Set up this Mac

From the repository root, using Python 3.12 or later:

```sh
python3 -m venv tools/camera-join/.venv
tools/camera-join/.venv/bin/python -m pip install -r tools/camera-join/requirements.txt
tools/camera-join/.venv/bin/python tools/camera-join/camera_join.py devices
tools/camera-join/.venv/bin/python tools/camera-join/camera_join.py markers
```

The dependencies are isolated in `.venv`; they do not change Expo's packages. Tested here with Python 3.14, OpenCV 4.14.0.94, NumPy 2.5.4, and websockets 17.3. `devices` probes indices 0–5 through macOS AVFoundation and prints available indices/resolutions; OpenCV does not supply friendly device names. Grant Camera permission to the terminal in System Settings → Privacy & Security if requested. Use `--camera N` consistently when selecting a different index. Capture requests 1920×1080 but uses the camera's actual delivered resolution.

Open `markers/print.html` and print at **100% / actual size**. The reference sheet defaults to A3 landscape; if you only have A4, print the four individual reference SVGs and mount them yourself. Measure their centres into a **32 × 18 cm** rectangle: ID 10 top-left, 11 top-right, 12 bottom-right, 13 bottom-left, all upright. The black marker squares must measure **3 cm**, with white margin around each. Do not scale the print to fit.

Mount the MacBook so its camera sees both entire phones and all four reference markers. A normal upright laptop looking horizontally will not see phones lying below its field of view; use a secure angled/overhead arrangement. Keep the laptop and board fixed. Use even light and keep the working area near the middle of the image.

## Marker placement and dimensions

Defaults are Phone A = ID 0 and Phone B = ID 1. **Phone A is whichever iPhone initiates the existing phone-to-phone connection.** Attach the matching marker to that phone, its printed top pointing towards the screen's top. The simplest prototype placement is paper over the **centre of the active screen**, even though it obscures part of the game.

Copy `config.example.json` to the ignored `config.json` to customize the setup. Pass `--config tools/camera-join/config.json` to **markers, calibrate, and run**. Configure:

- `width_cm`, `height_cm`: measured **active screen** dimensions in portrait, excluding bezels/case. Example values are placeholders, not device specifications. The app uses these to map screen points into physical coordinates.
- `marker_offset_cm`: marker centre relative to the screen centre, `[right, up]` in centimetres in the phone's own frame. `[0, 0]` means exactly centred. A marker beside a phone must be on a **rigid attachment that moves with it**; a loose piece of paper cannot track the phone.
- `marker_rotation_deg`: marker's top turned anticlockwise relative to the phone's top. Default 0.
- `phone_marker_cm`, `reference_marker_cm`: measured black-square sizes; white margins are not part of the measurement. Phone IDs must be distinct 0–49 excluding reference IDs 10–13.

The reference marker faces and phone marker faces must be **coplanar**. Raise the reference sheet to the screen/marker height with a rigid support, and shim a thinner phone so both marker faces are at the same height. Differences in height, tilted phones, or out-of-plane attachments produce parallax errors, especially with an oblique MacBook camera. This is a flat-table prototype, not a 3D pose tracker.

## Calibrate, check, and run

```sh
tools/camera-join/.venv/bin/python tools/camera-join/camera_join.py calibrate
```

With all four reference markers visible, press **Space** to save `calibration.json`; **Q** cancels. A 16-corner homography maps the image onto tabletop centimetres, +x right and +y up. Calibration is rejected above 0.15 cm RMS fit residual. That residual describes fit to the reference board, **not independent physical accuracy**. Lens distortion is not modelled separately.

```sh
tools/camera-join/.venv/bin/python tools/camera-join/camera_join.py run
```

The window shows marker IDs, screen outlines, screen centres, top/right axes, quality scores, screen-edge gap, centre distance, relative angle, and recent stationary jitter. Quality is a heuristic based on marker pixel size, square shape, and known physical size; it is not a probability or error bound. Markers need a shortest side of roughly 24 pixels or more to pass the quality gate.

Before connecting the app, compare centre distance against a ruler and relative angle against a known arrangement. To display errors against an independent measurement, for example 8 cm between screen centres with parallel phones:

```sh
tools/camera-join/.venv/bin/python tools/camera-join/camera_join.py run --check-distance-cm 8 --check-angle-deg 0
```

Those optional values are **measurement references**, not corrections. Change the known values when measuring another arrangement. Validate in several parts of the board, and look for persistent bias as well as jitter. Nothing in the prototype establishes the earlier suggested 2–5 cm / 3–8° accuracy targets without this physical test. Cross-screen gates allow only a **15 mm** gap, so multi-centimetre error can prevent or misplace crossing even when the pose looks plausible.

Find the Mac's Wi-Fi address in System Settings → Wi-Fi → Details → TCP/IP. Keep both iPhones on a network that allows devices to contact each other and allow incoming Python connections if macOS asks.

1. Start the same app version on both phones. Open **Link**, enable linking, and connect from one phone. In Spatial Lab, connect the phones normally instead.
2. On **both** phones, enter `ws://<Mac-Wi-Fi-IP>:8765` under **MacBook camera**, then tap **Connect camera**. The address is remembered locally. There is no automatic network scan.
3. Both camera clients must be connected, both phone markers visible with quality ≥0.6, and their positions stable within 0.5 cm / 3° for at least one second. The apps then auto-join. This geometry does not require UWB direction or gyro alignment.
4. Slide or rotate either phone: crossing closes while movement exceeds the stability threshold, then automatically rejoins after settling. Move B from right to left of A and back to verify repeated automatic side changes. Wide gaps can be tracked, but crossing opens only where screens are within the existing 15 mm threshold.
5. Hide either phone marker or a reference marker: layouts invalidate immediately. Restore visibility to reacquire. A reference-corner shift above 3 image pixels, resolution change, or config change latches calibration invalid: stop, recalibrate, restart the companion, and reconnect both apps.
6. Quit the companion or interrupt Wi-Fi: the app clears camera geometry after at most 1.2 seconds without a fresh sequence. Tap **Reconnect camera** after restarting. A new companion session requires reconnecting; old packets cannot keep the join alive.
7. For the original join, choose **Use swipe instead** on both phones, then use **Swipe fallback**. Selecting camera mode clears an existing swipe join and ignores incoming swipe states until camera mode is disabled.

The iOS config plugin adds `NSAllowsLocalNetworking` and updates the local-network permission text. Apply it with the project's usual prebuild/development-build workflow for a fresh native binary; TypeScript compilation or these tests do not prove an installed iPhone build has the new settings. Existing development builds may already permit the connection; verify on device. The prototype's unauthenticated WebSocket server defaults to `0.0.0.0:8765`; use it on your trusted local network. `--host 127.0.0.1` is suitable for desktop-only diagnostics. `--headless` disables the debug window after calibration.

## Protocol and validation

Version 1 text JSON uses `protocol: "distbugs.camera"`, a per-run `sessionId`, increasing `sequence`, and either `layout` or `layout_invalid`. A valid layout includes `stableMs`, the `table_cm_x_right_y_up` coordinate system, `phones` (role, marker ID, screen centre, heading, screen dimensions, marker pixels, screen corners, quality), `edgeGapCm`, and diagnostic fit/jitter/timestamp fields. Invalid messages carry a human-readable reason. The app checks types, finite/ranged coordinates and dimensions, unique roles and IDs, quality, and stability before constructing a camera-sourced `Stitch`.

Each client first sends `{ "protocol": "distbugs.camera", "version": 1, "type": "hello", "role": "A" }` (or B), then the same envelope with `type: "heartbeat"` every 400 ms. Valid layouts require a live heartbeat from **both different roles** within 1.2 seconds. Reconnecting the same role replaces its old connection. This also closes crossing on the remaining phone when its partner loses the camera link.

The Mac reads at up to 10 Hz and broadcasts current geometry; it does not replay cached layouts to new connections. Each phone uses its own receipt clock for a 1.2 s watchdog, rather than comparing unsynchronized Mac and iPhone clocks. An explicit invalid message immediately clears camera geometry. Camera mode never substitutes a last-known pose after loss. In-flight bug acknowledgements still use the existing transfer protocol.

## Swipe media demo

The app's **Open Swipe demo** button opens a separate live-media mode. On the Mac, start the camera companion with a media URL reachable from both phones:

```sh
tools/camera-join/.venv/bin/python tools/camera-join/camera_join.py run \
  --media-url http://<Mac-Wi-Fi-IP>:8000/sample.jpg \
  --media-kind image
```

Use `--media-kind video` for a video URL and provide its pixel dimensions with `--media-width` and `--media-height`. Start a local static file server separately. Open **Swipe** on both phones, choose Phone A or Phone B, enter `ws://<Mac-Wi-Fi-IP>:8765`, and connect. The phones show the media beneath their tracked tabletop rectangles; translation and rotation are live, and a brief camera interruption freezes the last valid view with a warning.

## Verification

```sh
cd tools/camera-join
.venv/bin/python -m unittest -v
```

From the repository root, also run the Jest suite and TypeScript check. Python tests cover perspective projection, rotations, marker offsets, gaps/overlap, stability, low confidence, occlusion, side changes, calibration movement, real marker detection, and a real two-client WebSocket integration using synthetic camera frames. TypeScript tests cover packet validation, coordinate conversion, physically sized crossing gates, watchdog expiry, duplicates/reordering, session replacement, and cleanup. No synthetic test establishes physical camera accuracy or iPhone runtime success.
