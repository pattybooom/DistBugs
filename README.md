# DistBugs

DistBugs is a two-phone last-bug-standing battle game. Each player builds one starter bug, chooses a signature power, and releases it into the same seeded arena. Bugs navigate and choose targets autonomously; aggression drives combat rather than only intimidation.

## Battle mode

- **One starter.** Each player starts with one larger bug. There are no inherited stat or visual mutations; any offspring copy their parent's build exactly.
- **Aggression.** Higher aggression makes a bug choose enemies sooner, deal more damage, attack on a shorter cooldown, and resist retreating. It also increases hunger drain and risk. The old rule—fleeing from a clearly more aggressive hungry bug—is retained as a low-health threat response, but aggression now has direct combat consequences.
- **Powers.** Choose one signature power: dash, shield, stun pulse, regeneration, or frenzy. Powers have deterministic cooldowns and visible effects in the battle HUD and event log.
- **Arena generation.** Every ecosystem has a saved seed, biome, water, hazards, cover, structures, and spawn points. The same seed generates the same arena on both phones. Water and structures block movement; food is spawned more frequently to keep fights moving.
- **Battle persistence.** Combat continues without automatically declaring a winner or ending the battle when one side has no surviving bugs. Ecosystem mode retains its existing population-end condition.

The original autonomous two-starter ecosystem remains available to legacy saves and tests as a compatibility mode, but new releases use battle mode.

## Ecosystem

- **Workshop.** Each starter has a look (body, eyes, horns, feature, colour palette) and a behaviour (speed, aggression, lifespan, hunger rate, food needed to breed). *Randomise* rolls a pair from the ecosystem's seed.
- **Habitat.** Fills the whole screen, edge to edge, with the controls floating over it on see-through panels. It is 360 units wide and as tall as the screen's shape makes it (783 on an iPhone 17); older saves are stretched to fit. Food spawns at the same density as in a 360 × 520 habitat (there, about every 1.8 s and at most 14 at once) and expires after 20 s, blinking for its last 4 s.
- **Behaviour.** A bug heads for the nearest food within 120 units, otherwise it wanders. Satiety (0–100) drains at the hunger rate, faster for fast and aggressive bugs, and each meal adds 30. A hungry bug that is clearly more aggressive (by 0.15 or more) chases a calmer one away.
- **Life cycle.** A bug dies of old age at the end of its lifespan, or of starvation when satiety reaches 0. Once it has lived 15% of its lifespan, eaten its breeding threshold and has satiety of at least 35, it lays one offspring nearby (population cap 40). Newborns are drawn small and grow as they mature; old bugs fade; hungry bugs show a red bar.
- **Inheritance.** Each behaviour trait drifts by at most one small mutation step per generation, within its range. One birth in 25 also changes the look slightly: a hue nudge (never past ±40°) or a step to the neighbouring feature. Body, eyes and horns are always inherited unchanged.
- **Inspector.** Tap a bug to see its age, fullness, food towards its next offspring, each trait next to its parent's, any visual mutation, and its lineage.
- **End.** When fewer than two bugs are left, the ecosystem ends and offers a new starter pair. It never invents a bug.

Pacing is tuned so a bug's life takes 1–3 minutes: with the default starters the first offspring hatches after about 20 s and the first deaths come after 1–2 minutes.

The simulation (`src/game/`) is plain TypeScript with no React Native imports. It is seeded (`Random.ts`, Mulberry32, whose state is saved with the ecosystem) and advances in fixed 50 ms steps (`stepSimulation`), so the same seed always plays out the same way and the tests can drive it directly. `SimulationDriver` turns frame time into steps (a long frame advances at most 0.25 s) and decides when to save. Sprites (`sprites.ts`) are assembled from hand-drawn pixel components and recoloured from the palette.

The ecosystem is saved with AsyncStorage on every birth and death, at least every 15 s while running, when pausing, and when the app leaves the foreground. Leaving the foreground also pauses it, so no simulated time passes while the app is closed; on the next launch it is restored paused and *Resume* carries on.

## Linking two phones

**MacBook camera prototype:** Both phones can now join automatically from printed markers viewed by a calibrated MacBook webcam. See [camera setup, printing, calibration, and run instructions](tools/camera-join/README.md). The camera option is available in Link and Spatial Lab; the swipe flow below remains the fallback. Hardware accuracy and iPhone network behavior still need live validation.

Two phones can join their habitats so bugs walk from one to the other. Open **Link** on both phones and connect from one; the phone that connects is Phone A. Lay the phones flat with their edges touching and swipe one finger from one screen onto the other, the same swipe join the Spatial Lab uses (`Stitch.ts`). Once joined, the open stretches of each habitat's walls glow blue along the screen's edge.

- **Where walls open** (`src/game/crossing.ts`). Each phone sends the other where its habitat is drawn on screen (`layout` message), which is the whole screen. A wall is open where walking straight out of it reaches the other habitat within 15 mm: the two bezels (7 mm) plus slack for cases and an imperfect join. So a bug crosses only once it reaches the physical edge of the screen, and only where that edge meets the other phone. The bug arrives at that point, heading the same way across the table; a bug heading almost along the wall is turned to walk straight in.
- **No motion data.** Both phones report the same heading in the join, so it comes out in Phone A's screen frame. Turning or sliding a phone afterwards is not tracked: swipe again (**Join again**).
- **Handing over** (`useBugBridge.ts`). A bug that walks through an open wall leaves the simulation (`departed` event) and is sent across. It stays this phone's until the other phone confirms it took it. If the other phone turns it away (not running, paused or full), doesn't answer within 4 s, or the connection drops, the bug walks back in where it left. The arriving bug gets a new id there and keeps its name, traits and lineage.
- **Never empties a habitat.** Bugs only leave while more than two stay behind, so crossing never ends an ecosystem.
- Linking stops while the Spatial Lab is open, since both use the same connection, and restarts on return. A bug in flight when the app is closed can be lost.

## Spatial Lab

The original two-phone prototype is kept as a separate screen, opened with **Spatial Lab** from the ecosystem or the workshop. Leaving the lab disconnects from the other phone. The rest of this README describes it.

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

After the development build is installed, run `npx expo start --dev-client`; TypeScript UI, smoothing, layout, and visualization changes use Fast Refresh. Rebuild only after changing native dependencies (such as AsyncStorage), `modules/parallax-module`, `plugins/withParallaxIos`, iOS permissions, entitlements, or other native configuration.

## M2 spatial acceptance checklist

This repository does not claim physical-device success yet. Install the same development build on both phones (it must include the gyro-only motion change; the **FRAME** row reads `GYRO ONLY` when it does). Grant local-network and motion permissions and select the other phone from Phone A. Ranging starts by itself once the phones connect. Then verify:

- raw and smoothed UWB distance keep updating, and the smoothed value follows the phones all the way in to touching;
- both phones show the join screen, and one swipe in either direction joins them;
- turning either phone in place turns it on both maps, and sliding one more than about 5 cm away marks the join `MOVED` and reopens the join screen on both;
- `WORLD GRAVITY` reads close to `[0.00, 0.00, -1.00]` for each phone in any pose, which confirms the device-to-reference transform;
- disconnect/reconnect and Nearby Interaction recovery restore diagnostics correctly.

## Swipe join

The iPhone 17 and iPhone 14 Plus report no Nearby Interaction direction without camera assistance, and UWB distance alone cannot say which side a phone is on. The phones are joined the way multi-screen demos usually do it instead: lay them flat with their edges touching and drag one finger from one screen straight onto the other.

Each phone reads its half of the trail (`src/spatial/Stitch.ts`). The sending phone fits a line to the last 25 mm of the trail and follows it out to the edge it left by. The receiving phone does the same for the edge the finger arrived at. Phone B sends its half to Phone A, which pairs halves that are on different phones and less than 0.7 s apart, then sends the join back. The finger keeps one physical direction across both screens, so the difference between its two directions is how far B is turned against A. A turn within 12° of a quarter turn snaps to it. The finger is assumed to cross two 3.5 mm bezels (`BEZEL_MM`) in a straight line, which places B's centre. Screen points are converted at 6.02 points per mm (`POINTS_PER_MM`), right for both test phones. When a join lands, both phones play a link animation: a spark runs from the centre of the phone the swipe started on to the other's centre. Each phone draws the same path on the table in its own screen points (`tableToScreen`), so the spark leaves one screen and crosses onto the other.

After the join, each phone's heading comes from Core Motion's gyro-only `xArbitraryZVertical` frame. Magnetic north is not used: next to another phone's MagSafe magnets it is wrong, and it changes as the phones move. The join records how B's frame relates to A's, so turning either phone in place is followed straight away. Motion runs for the whole connection and is published at 20 Hz independently of UWB, because restarting Core Motion moves the gyro frame's zero. A restart marks the join `MOVED`.

UWB is used only to notice that the phones were moved apart or together (`MovedApartCheck`). Its close-range bias is unknown, so the check compares the change in smoothed distance since the join with the change the join predicts from rotation, using the antenna about 5.5 cm towards the top edge. A disagreement above 5 cm held for 0.7 s marks the join `MOVED` and both phones show the join screen again. Sliding a phone without turning it is not tracked between joins.

Distance smoothing (`src/state/DistanceFilter.ts`) advances on every reading. Before, the display fed the smoother only when the value changed, so repeated identical close readings left it stuck at an older, larger distance. Each phone uses its own readings and falls back to the other phone's relayed ones only while its own are stale.

The spin test (`SpinBearing.ts`) and dead reckoning (`MotionTracker.ts`) remain in the repository with their tests but are no longer used by the app.
