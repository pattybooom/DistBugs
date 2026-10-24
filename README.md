# Parallax M2

Small Expo + TypeScript prototype for iPhone-to-iPhone Nearby Interaction. The native module owns MultipeerConnectivity, token exchange, NISession lifecycle, recovery, Core Motion, peer telemetry, and structured diagnostics. The TypeScript layer owns spatial transforms, smoothing, position validity, and presentation.

Phone A is the device that initiates the connection. Both phones render the same Phone A-centred scene. Phone B is placed by a swipe across both screens (see **Swipe join**); until then the scene shows `POSITION UNKNOWN`, and distance remains available independently.

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

This repository does not claim physical-device success yet. Install the same development build on both phones (it must include the gyro-only motion change; the **FRAME** row reads `GYRO ONLY` when it does). Grant local-network and motion permissions and select the other phone from Phone A. Ranging starts by itself once the phones connect. Then verify:

- raw and smoothed UWB distance keep updating, and the smoothed value follows the phones all the way in to touching;
- both phones show the join screen, and one swipe in either direction joins them;
- turning either phone in place turns it on both maps, and sliding one more than about 5 cm away marks the join `MOVED` and reopens the join screen on both;
- `WORLD GRAVITY` reads close to `[0.00, 0.00, -1.00]` for each phone in any pose, which confirms the device-to-reference transform;
- disconnect/reconnect and Nearby Interaction recovery restore diagnostics correctly.

## Swipe join

The iPhone 17 and iPhone 14 Plus report no Nearby Interaction direction without camera assistance, and UWB distance alone cannot say which side a phone is on. The phones are joined the way multi-screen demos usually do it instead: lay them flat with their edges touching and drag one finger from one screen straight onto the other.

Each phone reads its half of the trail (`src/spatial/Stitch.ts`). The sending phone fits a line to the last 25 mm of the trail and follows it out to the edge it left by. The receiving phone does the same for the edge the finger arrived at. Phone B sends its half to Phone A, which pairs halves that are on different phones and less than 0.7 s apart, then sends the join back. The finger keeps one physical direction across both screens, so the difference between its two directions is how far B is turned against A. A turn within 12° of a quarter turn snaps to it. The finger is assumed to cross two 3.5 mm bezels (`BEZEL_MM`) in a straight line, which places B's centre. Screen points are converted at 6.02 points per mm (`POINTS_PER_MM`), right for both test phones.

After the join, each phone's heading comes from Core Motion's gyro-only `xArbitraryZVertical` frame. Magnetic north is not used: next to another phone's MagSafe magnets it is wrong, and it changes as the phones move. The join records how B's frame relates to A's, so turning either phone in place is followed straight away. Motion runs for the whole connection and is published at 20 Hz independently of UWB, because restarting Core Motion moves the gyro frame's zero. A restart marks the join `MOVED`.

UWB is used only to notice that the phones were moved apart or together (`MovedApartCheck`). Its close-range bias is unknown, so the check compares the change in smoothed distance since the join with the change the join predicts from rotation, using the antenna about 5.5 cm towards the top edge. A disagreement above 5 cm held for 0.7 s marks the join `MOVED` and both phones show the join screen again. Sliding a phone without turning it is not tracked between joins.

Distance smoothing (`src/state/DistanceFilter.ts`) advances on every reading. Before, the display fed the smoother only when the value changed, so repeated identical close readings left it stuck at an older, larger distance. Each phone uses its own readings and falls back to the other phone's relayed ones only while its own are stale.

The spin test (`SpinBearing.ts`) and dead reckoning (`MotionTracker.ts`) remain in the repository with their tests but are no longer used by the app.
