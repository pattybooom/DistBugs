# Parallax M2

Small Expo + TypeScript prototype for iPhone-to-iPhone Nearby Interaction. The native module owns MultipeerConnectivity, token exchange, NISession lifecycle, recovery, Core Motion, peer telemetry, and structured diagnostics. The TypeScript layer owns spatial transforms, smoothing, position validity, and presentation.

Phone A is the device that initiates the connection. Both phones render the same Phone A-centred scene. A measured Phone B position is shown only when both devices provide a valid magnetic-north frame and Nearby Interaction provides a valid direction. Otherwise the scene deliberately shows `POSITION UNKNOWN`; distance remains available independently.

## Development

Use Node 24 on this machine if Homebrew Node 25 reports a missing `libsimdjson` library:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm install
npx expo prebuild
npx expo start --dev-client
```

The first native build must happen after the module and config plugin exist:

```sh
eas login
eas build:configure
eas device:create
eas build --profile development --platform ios
```

Register both physical iPhones with `eas device:create` (or the EAS dashboard). No USB cable is required: each phone opens the generated registration URL, installs the device profile, and EAS includes the registered UDID in the ad hoc build. Install the resulting build from its EAS-generated URL. The broken Lightning port is therefore not a blocker.

After the development build is installed, run `npx expo start --dev-client`; TypeScript UI, smoothing, layout, and visualization changes use Fast Refresh. Rebuild only after changing `modules/parallax-module`, `plugins/withParallaxIos`, iOS permissions, entitlements, or other native configuration.

## M2 spatial acceptance checklist

This repository does not claim physical-device success yet. On both phones: install the same development build, grant local-network and motion permissions, start discovery, select the other phone from Phone A, start ranging, and verify:

- raw and smoothed UWB distance continue updating;
- Phone A remains the origin and Phone B is only placed when direction is measured or a spin test is accepted;
- `WORLD GRAVITY` reads close to `[0.00, 0.00, -1.00]` for each phone in any pose, which confirms the device-to-reference transform;
- flat side-by-side, stacked, upright-facing, rotated, and separated arrangements are tested;
- direction loss changes the scene to `POSITION UNKNOWN` without inventing coordinates;
- disconnect/reconnect and Nearby Interaction recovery restore diagnostics correctly.

## Spin test

The iPhone 17 and iPhone 14 Plus both report no Nearby Interaction direction without camera assistance. The spin test estimates the bearing from distance and heading instead: swinging a phone flat on the table around the middle of its bottom edge carries the UWB antenna, near the top, round a circle about a phone-length wide, so the measured distance rises and falls once per turn, shortest when the antenna faces the other phone. Spinning about the phone's centre gives a wave only a few centimetres high, which UWB noise swamps.

While ranging, press **Start spin test**, hold a fingertip on the middle of one phone's bottom edge and swing the phone around it for two slow full turns and back, then press **Finish spin test**. A spin of Phone A places Phone B as `ESTIMATED`; a spin of each phone also lines up their rotations without a common magnetic frame. Results stay on the phone where Start was pressed, so press it on both phones to see the result on both.

A spin is accepted when the bearing's standard error is within 10°. The diagnostics show each fit's coverage, wave size, noise, bearing with its ± error, and a plot of distance against heading with the fitted wave. **Share spin data** exports the raw readings as JSON for offline analysis. `ANTENNA_ANGLE_FROM_TOP_RAD` in `src/spatial/SpinBearing.ts` assumes the antenna lies straight up from the pivot; check the bearing against a known layout and adjust it if the result is consistently off. Physical accuracy is unverified.

Manual calibration, experiment recording, and JSON export are intentionally deferred.
