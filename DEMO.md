# DistBugs demo plan

About 5 minutes live, plus an optional 1-minute encore. Two iPhones lie flat on a table, a MacBook watches them through its webcam, and bugs walk from one screen onto the other.

## The pitch for the theme

The hackathon theme is *time*, and *data for predictions and decision making*. The one-line pitch:

> **DistBugs is evolution you can watch in real time. Every bug makes a decision from live data 20 times a second, and the whole system decides where the phones are from sensor data, predicting where they are even when it can't see them.**

These are the real mechanisms behind each part of the theme. Use them in the script and in Q&A:

| Theme | What's actually in the code |
|---|---|
| **Time as evolution** | A bug lives for 1–3 minutes, so you can watch generations turn over during the demo. Each birth drifts the traits a little, and over time the bugs that win fights and find food take over. |
| **Time as determinism** | The simulation runs in fixed 50 ms steps from a saved seed. The same seed always plays out the same way, and both phones generate the identical arena. No time passes while the app is closed. |
| **Decisions from data** | On every step, each bug reads its surroundings (nearest food within 120 units, its own hunger and health, how aggressive its rivals are) and decides whether to eat, chase, fight, flee or breed. |
| **Decisions from sensors** | The Mac turns camera frames into screen positions, then decides which wall is open and where. Smoothing (median filter plus One Euro filter) trades a little lag for fewer false jumps. |
| **Prediction** | When a phone sits still, its square disappears and the Mac keeps using its last known position, because the motion sensor says the phone hasn't moved. If the camera loses a phone, the crossing stays open on the last known position for 2 s. In the Swipe demo, each phone estimates its clock offset from the Mac to work out where the shared video should be right now. |

Be careful with prediction: the app makes *short-term* predictions (positions, clocks) but doesn't yet *forecast* the ecosystem. The seed makes one possible, but nothing in the app shows it yet.

## Kit

- iPhone 17 (Phone A) and iPhone 14 Plus (Phone B), both charged, with the current development build installed.
- MacBook on a fixed stand or a stack of books, webcam pointing down at a plain, matte, evenly lit table. Don't touch it after setup.
- Everything on one Wi-Fi network that allows device-to-device traffic. Bring a travel router or use the Mac's hotspot in case the venue Wi-Fi blocks local traffic.
- Backup: a screen recording of a good run (see Pre-flight).

## Pre-flight

### The day before

1. Commit the work in progress. There are about 1,200 changed lines across 25 files. The 200 Jest tests, `tsc` and the 27 Python tests all pass as of 25 Oct.
2. Check whether the phones need a rebuild. The only native change adds `startMotion`/`stopMotion` to the Swift module. It's optional: without it, an older build only senses motion while the phones are linked, which is fine for the DistBugs link. You only need a new EAS build if the standalone Swipe demo should hide its square without linking first.
3. Do a full run at the venue, or in similar lighting, and screen-record both phones and the tracker window. That recording is your backup.
4. Put both phones on Do Not Disturb, turn off auto-lock and set brightness to full. The camera needs bright squares.

### 30 minutes before

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx expo start --dev-client
```

```bash
ipconfig getifaddr en0
```

The IP is 10.21.240.35 at home, but it will be different at the venue.

```bash
tools/camera-join/.venv/bin/python tools/camera-join/camera_join.py swipe --camera 0 --config tools/camera-join/config.json
```

- Open DistBugs on both phones from the dev server, then build each phone's starter bug in the workshop now so you don't have to on stage.
- Open **Link** on both phones and connect from the iPhone 17, which makes it Phone A. Tap **Connect camera** on both and enter `ws://<IP>:8765`.
- In the tracker window, both squares should read about 30 px or more (`A 30 px`, `B 31 px`). If one reads `not found` or is under 22 px, lower the camera or move the phones closer.
- Walk a bug across once to confirm the link works, then pause both ecosystems.

## Run of show

| Time | On the table | What you say |
|---|---|---|
| 0:00 | Phones touching, ecosystems resumed, bugs already crossing | Hook |
| 0:45 | Tap a bug, then the inspector | Decisions from data |
| 1:45 | Slide one phone away, then rotate it | Sensors and prediction |
| 3:00 | Let the fight run; point at powers, births and `gen N` in the log | Time as evolution |
| 4:15 | Hands off | Close |
| 5:00 | *(optional)* Spatial Lab → Swipe demo | Encore |

## Script

**Hook (0:00).** Resume both phones before you start talking.

> "Our theme is time, and using data to make decisions. Here's evolution running in real time, across two phones." *(point as a bug walks off Phone A onto Phone B)* "That bug just walked from one phone onto the other. These are separate devices with no shared screen and no cloud server. When it left this screen, it stopped existing here and was handed to that phone."

**Decisions from data (0:45).** Tap a bug.

> "Each of us built one starter bug: what it looks like, how fast it is, how aggressive, how hungry. We each gave it a power: dash, shield, stun, regenerate or frenzy. Then we let go. Nobody steers them. Twenty times a second, every bug looks at the data around it: where the nearest food is, how hungry and hurt it is, how aggressive the bug next to it is. Then it decides whether to eat, fight, flee or breed. You're watching dozens of small decisions every second."

**Sensors and prediction (1:45).** Slide Phone B a few centimetres away, then turn it 90°.

> "The system makes decisions too. How does a bug know where the other phone is? That's the MacBook." *(gesture at the camera)* "When a phone moves, it puts up this black-and-white square. The Mac reads it, works out where both screens are on the table and sends just the coordinates, not video. From that data it decides which wall is open: bugs can only cross on the side that actually faces the other phone. Turn the phone and the open side turns with it."
>
> *(once it settles)* "Now watch: the square disappears. The camera can't see the phone any more, but the phone's motion sensor says it hasn't moved, so the Mac keeps predicting it's still in the same place. The moment it moves, the square comes back and the Mac picks it up again."

Push the phones back together so the bugs can cross again.

**Time as evolution (3:00).** Point at a `hatched · gen N` line in the log.

> "Time is what makes this work. A bug lives for one to three minutes, so you can see generations go by during a demo. Every baby is a slightly mutated copy of its parent: a bit faster, a bit more aggressive, sometimes a new colour. Over time, the data decides: bugs whose changes help them win fights and find food live long enough to breed, and the rest die out. That's generation" *(read the number)* "already."

**Close (4:15).**

> "The world runs in fixed 50-millisecond steps from a shared seed, so the same seed always plays out the same way, and both phones build the exact same arena. Bugs decide from data, the system predicts where the phones are from sensor data, and evolution happens on a clock you can watch. Two phones, one webcam, no cloud. Questions?"

**Encore (optional).** Restart the tracker with `--media-url http://<IP>:8000/icon.png --media-kind image` and serve `assets` with `python3 -m http.server 8000 --directory assets`. Open **Spatial Lab → Open Swipe demo**, choose A and B, then slide the phones around.

> "Same tracking, different use: one picture spread across both screens. Move a phone and it acts like a window onto the image."

## If something breaks

| Symptom | Recovery | Line |
|---|---|---|
| Square not found or tracking jumps | Tilt the screen away from glare, raise brightness and hold still for a second | "It's a webcam in a bright room. Give it a second." |
| Tracker or WebSocket down | Crossing closes after 2 s. Phones touching, then **Join again** with a finger swipe across both screens | "There's also a no-camera way. Just swipe from one screen to the other." |
| Phones won't connect to each other | Demo battle mode on one phone only, then play the recording | "Here's the cross-phone part from yesterday." |
| A bug in flight disappears | Ignore it. A bug only leaves while more than two stay behind | — |
| Dev server or Wi-Fi gone | The app keeps running from its bundle, so just avoid reloading. As a last resort, play the recording | — |

## Likely questions

- **"Could you predict who wins?"** "In principle, yes. It's deterministic, so you could fast-forward a copy of the world from the same seed. That's our next step." This is only true for one phone on its own: once bugs cross between phones, the timing of each handover depends on the network.
- **"What's the data?"** Each bug's traits and state, its family tree (tap a bug to see it), camera geometry at up to 30 fps, and motion at 20 Hz.
- **"Why a camera?"** These phones' UWB chips give distance but not direction, so they can't tell which side the other phone is on.

## Don't claim

- **Tracking accuracy.** It hasn't been measured on hardware. The README says the same.
- **A winner screen.** Battle mode never ends a battle by itself, so don't promise one.
- **Phones being lifted or tilted.** Tracking only works for phones lying flat on the table.
- **Moving the Mac.** If it gets bumped, press **R** in the tracker window to capture a new reference.
