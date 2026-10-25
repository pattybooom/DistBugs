#!/usr/bin/env python3
"""Local webcam tracker. Run --help for setup, printing, calibration and tracking."""
import argparse
import asyncio
import json
import math
from pathlib import Path
import socket
import time
import uuid

import cv2
import numpy as np
from websockets.asyncio.server import serve, broadcast
from websockets.exceptions import ConnectionClosed

from geometry import StabilityGate, phone_pose, screen_phone_pose, polygon_gap, project
from manual_calibration import calibrate_manual
from screen_calibration import ScreenAnchor
from smoothing import PoseSmoother

ROOT = Path(__file__).resolve().parent
REFERENCE_IDS = (10, 11, 12, 13)  # top-left, top-right, bottom-right, bottom-left


def load_config(path):
    config = json.loads(Path(path).read_text())
    phones = config["phones"]
    if len(phones) != 2 or {p["role"] for p in phones} != {"A", "B"}:
        raise ValueError("Configure exactly one Phone A and one Phone B")
    ids = [p["marker_id"] for p in phones]
    if len(set(ids)) != 2 or any(i in REFERENCE_IDS or not isinstance(i, int) or not 0 <= i < 50 for i in ids):
        raise ValueError("Phone marker IDs must be distinct 0..49, excluding 10..13")
    if config["dictionary"] != "DICT_4X4_50":
        raise ValueError("This prototype uses DICT_4X4_50")
    for key in ("reference_width_cm", "reference_height_cm", "reference_marker_cm", "phone_marker_cm"):
        if not math.isfinite(config[key]) or config[key] <= 0:
            raise ValueError(f"{key} must be positive and finite")
    if min(config["reference_width_cm"], config["reference_height_cm"]) <= config["reference_marker_cm"]:
        raise ValueError("Reference centres must be farther apart than marker width")
    for p in phones:
        for key in ("width_cm", "height_cm"):
            if not math.isfinite(p[key]) or p[key] <= 0:
                raise ValueError(f"Phone {key} must be positive and finite")
        offset = p.get("marker_offset_cm", [0, 0])
        if len(offset) != 2 or not all(math.isfinite(x) for x in offset) or not math.isfinite(p.get("marker_rotation_deg", 0)):
            raise ValueError("Marker offsets and rotation must be finite")
    check_screen_marker(config)
    return config


def screen_marker_cm(config):
    """Side of the square a phone draws on its own screen; the printed-board markers keep `phone_marker_cm`."""
    return config.get('screen_marker_cm', config['phone_marker_cm'])


def check_screen_marker(config):
    size = screen_marker_cm(config)
    if not math.isfinite(size) or size <= 0:
        raise ValueError('screen_marker_cm must be positive and finite')
    for p in config['phones']:
        ox, oy = p.get('marker_offset_cm', [0, 0])
        # The square plus its white margin (a sixth of its side on each edge) must stay on the screen.
        if abs(ox) > p['width_cm'] / 2 - size * 7 / 12 or abs(oy) > p['height_cm'] / 2 - size * 7 / 12:
            raise ValueError(f"Phone {p['role']} marker_offset_cm puts the square (with its white margin) off the screen")


def dictionary():
    return cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)


def detector():
    parameters = cv2.aruco.DetectorParameters()
    parameters.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    # Small on-screen squares are blurry and low-resolution, so search for smaller, softer, noisier markers than the defaults.
    parameters.minMarkerPerimeterRate = 0.01
    parameters.adaptiveThreshWinSizeMax = 43
    parameters.adaptiveThreshWinSizeStep = 8
    parameters.polygonalApproxAccuracyRate = 0.05
    parameters.maxErroneousBitsInBorderRate = 0.5
    parameters.perspectiveRemovePixelPerCell = 8
    return cv2.aruco.ArucoDetector(dictionary(), parameters)


def detect(frame, reader):
    corners, ids, _ = reader.detectMarkers(frame)
    result = {}
    if ids is not None:
        for marker, points in zip(ids.flatten(), corners):
            if int(marker) in result:
                raise ValueError(f"Duplicate marker ID {marker}")
            result[int(marker)] = points.reshape(4, 2)
    return result


def reference_world(config):
    w, h, size = (config[k] for k in ("reference_width_cm", "reference_height_cm", "reference_marker_cm"))
    centres = ((0, h), (w, h), (w, 0), (0, 0))
    square = np.array([[-1, 1], [1, 1], [1, -1], [-1, -1]]) * size/2
    return np.concatenate([square + c for c in centres])


def reference_pixels(markers):
    return np.concatenate([markers[i] for i in REFERENCE_IDS]) if all(i in markers for i in REFERENCE_IDS) else None


def fit_calibration(pixels, config):
    world = reference_world(config)
    matrix, _ = cv2.findHomography(np.asarray(pixels, dtype=float), world, 0)
    if matrix is None or not np.isfinite(matrix).all() or np.linalg.cond(matrix) > 1e8:
        raise ValueError("Calibration geometry is degenerate")
    residual = float(np.sqrt(np.mean(np.sum((project(pixels, matrix) - world)**2, axis=1))))
    if residual > .15:
        raise ValueError(f"Calibration residual {residual:.2f} cm exceeds 0.15 cm; check board and angle")
    return matrix, residual


def calibration_valid(calibration, pixels, frame_size, config):
    if calibration["frameSize"] != list(frame_size):
        return "Camera resolution changed; recalibrate"
    if calibration["config"] != config:
        return "Configuration changed; recalibrate"
    if calibration.get("mode") in ("manual", "screen"):
        # No printed references: camera motion cannot be detected automatically.
        return None
    if pixels is None:
        return "Keep all four calibration markers visible"
    shifts = np.linalg.norm(pixels - np.asarray(calibration["pixels"]), axis=1)
    if float(max(shifts)) > 3:
        return "Camera or reference board moved; recalibrate"
    return None


def marker_svg(marker_id, size_cm):
    bits = cv2.aruco.generateImageMarker(dictionary(), marker_id, 120)
    # Integer pixel cells in SVG preserve exact marker edges at any print scale.
    boxes = ''.join(f'<rect x="{x}" y="{y}" width="1" height="1"/>'
                    for y in range(120) for x in range(120) if bits[y, x] == 0)
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size_cm}cm" height="{size_cm}cm" viewBox="0 0 120 120"><rect width="120" height="120" fill="white"/><g fill="black">{boxes}</g></svg>'


def print_markers(config, output):
    output.mkdir(parents=True, exist_ok=True)
    for i in (*REFERENCE_IDS, *(p["marker_id"] for p in config["phones"])):
        size = config["reference_marker_cm"] if i in REFERENCE_IDS else config["phone_marker_cm"]
        (output / f"marker-{i}.svg").write_text(marker_svg(i, size))
    w, h, size = (config[k] for k in ("reference_width_cm", "reference_height_cm", "reference_marker_cm"))
    positions = ((0, 0), (w, 0), (w, h), (0, h))
    images = ''.join(f'<img src="marker-{i}.svg" style="position:absolute;left:{x+1}cm;top:{y+1}cm;width:{size}cm;height:{size}cm">'
                     for i, (x, y) in zip(REFERENCE_IDS, positions))
    phones = ''.join(f'<section style="break-before:page;padding:2cm">Phone {p["role"]} · ID {p["marker_id"]} · TOP ↑<br><img src="marker-{p["marker_id"]}.svg" style="margin:1cm"><p>Black square: {config["phone_marker_cm"]} cm. Keep the white margin clear.</p></section>' for p in config["phones"])
    (output / "print.html").write_text(f'<!doctype html><meta charset="utf-8"><title>Camera join markers</title><style>@page{{size:A3 landscape;margin:0}}body{{margin:0;font-family:sans-serif}}img{{image-rendering:pixelated}}</style><div style="position:relative;width:{w+size+2}cm;height:{h+size+2}cm">{images}</div>{phones}')
    print(f"Print {output / 'print.html'} at 100% / actual size. Reference centre spacing: {w} × {h} cm.")


def open_camera(index, width=1920, height=1080, fps=None):
    cap = cv2.VideoCapture(index, cv2.CAP_AVFOUNDATION)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera {index}. Grant camera access to your terminal in macOS Settings.")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    if fps:
        cap.set(cv2.CAP_PROP_FPS, fps)
    return cap


def list_devices():
    # OpenCV exposes device indices, not friendly names. Probe only on explicit --devices.
    for index in range(6):
        cap = cv2.VideoCapture(index, cv2.CAP_AVFOUNDATION)
        if cap.isOpened():
            print(f"Camera {index}: {int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))} × {int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}")
        cap.release()


def calibrate(args, config):
    cap, reader = open_camera(args.camera), detector()
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError("Camera stopped delivering frames")
            markers = detect(frame, reader)
            pixels = reference_pixels(markers)
            note = "Show markers 10, 11, 12, 13; SPACE captures, Q quits"
            matrix, residual = None, None
            if pixels is not None:
                try:
                    matrix, residual = fit_calibration(pixels, config)
                    note = f"SPACE to save. Fit residual {residual:.3f} cm (not measured accuracy)"
                except ValueError as error:
                    note = str(error)
            draw(frame, markers, None, note)
            cv2.imshow("Camera join calibration", frame)
            key = cv2.waitKey(1) & 0xff
            if key == ord('q'):
                break
            if key == 32 and matrix is not None:
                data = {"matrix": matrix.tolist(), "pixels": pixels.tolist(), "config": config,
                        "frameSize": [frame.shape[1], frame.shape[0]], "residualCm": residual, "camera": args.camera}
                Path(args.calibration).write_text(json.dumps(data, indent=2))
                print(f"Saved {args.calibration}; residual {residual:.3f} cm. Verify real distances with a ruler.")
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()


def draw(frame, markers, layout, note, matrix=None):
    for i, corners in markers.items():
        cv2.polylines(frame, [corners.astype(np.int32)], True, (100, 220, 100), 2)
        cv2.putText(frame, str(i), tuple(corners[0].astype(int)), cv2.FONT_HERSHEY_SIMPLEX, .7, (100, 220, 100), 2)
    if layout and matrix is not None:
        inverse = np.linalg.inv(matrix)
        for phone in layout:
            outline = project(phone["cornersCm"], inverse).astype(np.int32)
            cv2.polylines(frame, [outline], True, (255, 190, 80), 2)
            c = phone["centreCm"]
            centre = np.array([c["x"], c["y"]])
            direction = np.array([math.cos(phone["headingRad"]), math.sin(phone["headingRad"])])
            axes = project([centre, centre + direction * 4, centre + [direction[1]*3, -direction[0]*3]], inverse).astype(int)
            cv2.arrowedLine(frame, tuple(axes[0]), tuple(axes[1]), (80, 255, 80), 2)
            cv2.arrowedLine(frame, tuple(axes[0]), tuple(axes[2]), (80, 80, 255), 2)
            cv2.putText(frame, f'{phone["role"]} ({c["x"]:.1f},{c["y"]:.1f}) cm {math.degrees(phone["headingRad"]):.1f} deg Q {phone["confidence"]:.2f}', tuple(axes[0]), cv2.FONT_HERSHEY_SIMPLEX, .5, (255, 255, 255), 2)
    cv2.rectangle(frame, (0, 0), (frame.shape[1], 42), (20, 20, 20), -1)
    cv2.putText(frame, note[:130], (10, 28), cv2.FONT_HERSHEY_SIMPLEX, .6, (255, 255, 255), 1)


def screen_markers(config):
    return [{"role": p['role'], "markerId": p['marker_id'], "widthCm": p['width_cm'], "heightCm": p['height_cm'],
             "sizeCm": screen_marker_cm(config), "offsetCm": list(p.get('marker_offset_cm', [0, 0])),
             "cells": (cv2.aruco.generateImageMarker(dictionary(), p['marker_id'], 6) // 255).tolist()}
            for p in config['phones']]


def swipe_layout(message, phones, invalid, ready_roles, calibration, config, args):
    reason = invalid
    if not reason and (len(phones) != 2 or {p['role'] for p in phones} != {'A', 'B'}):
        reason = 'Keep both on-screen tracking squares visible'
    if not reason and any(p['confidence'] < getattr(args, 'min_confidence', .2) for p in phones):
        reason = 'Tracking square too small or unclear; move it closer to the camera'
    if not reason and polygon_gap(phones[0]['cornersCm'], phones[1]['cornersCm']) < -.2:
        reason = 'Phone outlines overlap; separate the phones or adjust the area'
    if not reason and ready_roles != {'A', 'B'}:
        reason = 'Connect Swipe on both phones, one as A and one as B'
    result = {**message, 'type': 'layout_invalid' if reason else 'layout', 'reason': reason or 'Tracking phones',
              'screenMarkers': screen_markers(config), 'calibrationMode': calibration.get('mode', 'board'),
              'area': {'widthCm': calibration.get('areaWidthCm', config['reference_width_cm']),
                       'heightCm': calibration.get('areaHeightCm', config['reference_height_cm'])}}
    if getattr(args, 'media_url', None):
        result['media'] = {'kind': args.media_kind, 'url': args.media_url, 'width': args.media_width,
                           'height': args.media_height, 'version': args.media_version, 'position': args.media_position}
        if getattr(args, 'media_started_ms', None) is not None:
            result['media']['startedAtMs'] = args.media_started_ms
    return result


async def run(args, config):
    args.media_started_ms = int(time.time() * 1000)  # shared video clock: phones play (now - this) into the loop
    auto_anchor = getattr(args, 'command', None) == 'swipe' and not getattr(args, 'manual_area', False)
    calibration = ({'mode': 'screen', 'residualCm': None} if auto_anchor else json.loads(Path(args.calibration).read_text()))
    matrix = None if auto_anchor else np.asarray(calibration["matrix"], dtype=float)
    anchor = ScreenAnchor()
    window_name = 'Swipe - MacBook camera' if getattr(args, 'command', None) == 'swipe' else 'DistBugs camera join'
    if not auto_anchor and args.camera != calibration["camera"]:
        raise ValueError("Camera index changed; recalibrate")
    cap = open_camera(args.camera, getattr(args, 'capture_width', 1920), getattr(args, 'capture_height', 1080), getattr(args, 'capture_fps', None))
    reader, gate = detector(), StabilityGate()
    rate, last_tick = 0.0, None
    if hasattr(cap, 'get'):
        print(f'Camera delivers {int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))} at {cap.get(cv2.CAP_PROP_FPS):.0f} fps (as reported)', flush=True)
    smoother = PoseSmoother()
    session, sequence = uuid.uuid4().hex, 0
    calibration_moved = False
    # Camera reads may block. Put capture in a worker so network handling remains responsive.
    clients = {}
    async def handle(ws):
        try:
            hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            if not isinstance(hello, dict) or hello.get('protocol') != 'distbugs.camera' or hello.get('version') != 1 or hello.get('type') != 'hello' or hello.get('role') not in ('A', 'B') or hello.get('mode', 'join') not in ('join', 'swipe'):
                await ws.close(1008, 'Expected camera hello with Phone A or B role')
                return
            role = hello['role']
            for previous, state in list(clients.items()):
                if state['role'] == role:
                    await previous.close(1000, 'Replaced by reconnect')
                    clients.pop(previous, None)
            screen_aspect = hello.get('screenAspect', 1)
            if not isinstance(screen_aspect, (int, float)) or isinstance(screen_aspect, bool) or not math.isfinite(screen_aspect) or not .2 <= screen_aspect <= 5:
                raise ValueError('Invalid screen aspect ratio')
            clients[ws] = {'role': role, 'mode': hello.get('mode', 'join'), 'seen': time.monotonic(),
                           'markerOnScreen': hello.get('markerOnScreen') is True, 'screenAspect': screen_aspect}
            async for raw in ws:
                heartbeat = json.loads(raw)
                if not isinstance(heartbeat, dict) or heartbeat.get('protocol') != 'distbugs.camera' or heartbeat.get('version') != 1 or heartbeat.get('type') != 'heartbeat' or heartbeat.get('role') != role:
                    await ws.close(1008, 'Invalid camera heartbeat')
                    break
                clients[ws]['seen'] = time.monotonic()
        except (ConnectionClosed, asyncio.TimeoutError, ValueError, TypeError):
            await ws.close(1008, 'Invalid camera handshake or heartbeat')
        finally:
            clients.pop(ws, None)
    try:
        async with serve(handle, args.host, args.port, max_size=4096, ping_interval=5, ping_timeout=5) as server:
            print(f"{'Swipe camera' if auto_anchor else 'Camera join'} listening on ws://<Mac Wi-Fi IP>:{args.port} · hostname {socket.gethostname()}", flush=True)
            print("Press Q to stop. Camera images stay on the Mac.", flush=True)
            while True:
                start = time.monotonic()
                if last_tick is not None and start > last_tick:
                    rate = 1 / (start - last_tick) if not rate else .9 * rate + .1 / (start - last_tick)
                last_tick = start
                ok, frame = await asyncio.to_thread(cap.read)
                markers, phones, invalid = {}, [], None
                if ok:
                    try:
                        markers = detect(frame, reader)
                        if matrix is None:
                            roles = {s['role'] for s in clients.values() if s['mode'] == 'swipe' and s['markerOnScreen'] and time.monotonic() - s['seen'] <= 1.2}
                            if roles == {'A', 'B'}:
                                captured, invalid = anchor.observe(markers, time.monotonic(), config, (frame.shape[1], frame.shape[0]), args.camera)
                                if captured:
                                    calibration = captured
                                    matrix = np.asarray(captured['matrix'], dtype=float)
                                    invalid = None
                                    print('Reference captured from phone screens. Move either phone; keep the Mac fixed. R resets.', flush=True)
                            else:
                                anchor.reset()
                                invalid = 'Connect Swipe on both phones, one as A and one as B'
                        else:
                            invalid = calibration_valid(calibration, reference_pixels(markers), (frame.shape[1], frame.shape[0]), config)
                        if invalid and ("moved" in invalid or "changed" in invalid):
                            calibration_moved = True
                        if calibration_moved:
                            invalid = "Camera calibration invalid; stop and recalibrate"
                        if invalid is None:
                            for spec in config["phones"]:
                                if spec["marker_id"] in markers:
                                    screen_client = next((s for s in clients.values() if s['role'] == spec['role'] and s['mode'] == 'swipe'
                                                          and s['markerOnScreen'] and time.monotonic() - s['seen'] <= 1.2), None)
                                    if screen_client:
                                        screen_spec = {**spec, 'height_cm': spec['width_cm'] / screen_client['screenAspect']}
                                        phones.append(screen_phone_pose(markers[spec['marker_id']], matrix, screen_spec, screen_marker_cm(config)))
                                    else:
                                        phones.append(phone_pose(markers[spec["marker_id"]], matrix, spec, config["phone_marker_cm"]))
                    except (ValueError, cv2.error) as error:
                        invalid = str(error)
                else:
                    invalid = "Camera tracking lost: no frames"
                stable, stable_ms, reason = gate.observe(phones, time.monotonic(), invalid)
                ready_roles = {state['role'] for state in clients.values() if state['mode'] == 'join' and time.monotonic() - state['seen'] <= 1.2}
                if stable and ready_roles != {'A', 'B'}:
                    stable, reason = False, "Connect camera on both phones"
                gap = polygon_gap(phones[0]["cornersCm"], phones[1]["cornersCm"]) if len(phones) == 2 else None
                centre_distance, relative_yaw = None, None
                if len(phones) == 2:
                    ordered = sorted(phones, key=lambda p: p['role'])
                    a, b = [p['centreCm'] for p in ordered]
                    centre_distance = math.hypot(b['x']-a['x'], b['y']-a['y'])
                    relative_yaw = math.degrees(math.atan2(math.sin(ordered[1]['headingRad']-ordered[0]['headingRad']), math.cos(ordered[1]['headingRad']-ordered[0]['headingRad'])))
                sequence += 1
                message = {"protocol": "distbugs.camera", "version": 1, "sessionId": session, "sequence": sequence,
                           "timestampMs": int(time.time()*1000), "type": "layout" if stable else "layout_invalid",
                           "stableMs": stable_ms, "reason": "Phones aligned" if stable else reason,
                           "coordinateSystem": "table_cm_x_right_y_up", "phones": phones, "edgeGapCm": gap,
                           "calibrationResidualCm": calibration["residualCm"], "jitterCm": gate.jitter_cm,
                           "centreDistanceCm": centre_distance, "relativeYawDeg": relative_yaw}
                swipe_roles = {s['role'] for s in clients.values() if s['mode'] == 'swipe' and time.monotonic() - s['seen'] <= 1.2}
                live_phones = smoother.apply(phones, time.monotonic()) if getattr(args, 'command', None) == 'swipe' else phones
                live_message = swipe_layout({**message, 'phones': live_phones}, live_phones, invalid, swipe_roles, calibration, config, args)
                if calibration.get('mode') in ('manual', 'screen'):
                    message['type'], message['reason'] = 'layout_invalid', 'Screen/area calibration is for Swipe; use reference-board calibration for camera join'
                for mode, payload in (('join', message), ('swipe', live_message)):
                    broadcast([ws for ws, state in clients.items() if state['mode'] == mode], json.dumps(payload, allow_nan=False))
                if ok and not args.headless:
                    note = f'{live_message["reason"] if swipe_roles or calibration.get("mode") in ("manual", "screen") else message["reason"]} · clients {len(clients)} · {rate:.0f} fps'
                    if calibration.get('mode') in ('manual', 'screen'):
                        note += ' · R reset reference · Q quit'
                    # How big each square looks to the camera, to tell "too small" from "not found".
                    for spec in config['phones']:
                        corners = markers.get(spec['marker_id'])
                        size = f"{min(np.linalg.norm(corners - np.roll(corners, -1, axis=0), axis=1)):.0f} px" if corners is not None else 'not found'
                        note += f" · {spec['role']} {size}"
                    if gap is not None:
                        note += f' · gap {gap:.2f} cm'
                    draw(frame, markers, phones, note, matrix)
                    if centre_distance is not None:
                        checks = f'Centres {centre_distance:.2f} cm | relative turn {relative_yaw:.1f} deg | jitter {gate.jitter_cm:.3f} cm'
                        if args.check_distance_cm is not None:
                            checks += f' | ruler error {centre_distance-args.check_distance_cm:+.2f} cm'
                        if args.check_angle_deg is not None:
                            error = math.degrees(math.atan2(math.sin(math.radians(relative_yaw-args.check_angle_deg)), math.cos(math.radians(relative_yaw-args.check_angle_deg))))
                            checks += f' | angle error {error:+.1f} deg'
                        cv2.putText(frame, checks, (10, frame.shape[0]-20), cv2.FONT_HERSHEY_SIMPLEX, .55, (0, 0, 0), 3)
                        cv2.putText(frame, checks, (10, frame.shape[0]-20), cv2.FONT_HERSHEY_SIMPLEX, .55, (255, 255, 255), 1)
                    cv2.imshow(window_name, frame)
                    key = cv2.waitKey(1) & 0xff
                    if key == ord('r') and getattr(args, 'command', None) == 'swipe':
                        if auto_anchor:
                            matrix = None
                            calibration = {'mode': 'screen', 'residualCm': None}
                            calibration_moved = False
                            anchor.reset()
                            gate.reset()
                            continue
                        return True
                    if key == ord('q') or cv2.getWindowProperty(window_name, cv2.WND_PROP_VISIBLE) < 1:
                        break
                await asyncio.sleep(max(0, 1 / args.fps - (time.monotonic() - start)))
    finally:
        cap.release()
        cv2.destroyAllWindows()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("devices", "markers", "calibrate", "calibrate-manual", "swipe", "run"))
    parser.add_argument("--config", default=str(ROOT / "config.example.json"))
    parser.add_argument("--calibration", help="Saved calibration file (Swipe uses swipe-calibration.json)")
    parser.add_argument("--recalibrate", action="store_true", help="Draw a fresh area before starting Swipe")
    parser.add_argument("--manual-area", action="store_true", help="Optional: draw four corners instead of automatic screen-square setup")
    parser.add_argument("--area-width-cm", type=float, default=32, help="Estimated area width; default 32 cm")
    parser.add_argument("--area-height-cm", type=float, default=18, help="Estimated area height; default 18 cm")
    parser.add_argument("--output", default=str(ROOT / "markers"))
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--marker-cm", type=float, help="Swipe: side of the on-screen tracking square in cm (default: screen_marker_cm in the config, else phone_marker_cm)")
    parser.add_argument("--fps", type=float, default=30, help="Maximum layout updates per second; default 30")
    parser.add_argument("--capture-width", type=int, default=1920, help="Requested camera width; lower it (for example 1280) if the camera offers more frames per second there")
    parser.add_argument("--capture-height", type=int, default=1080)
    parser.add_argument("--capture-fps", type=float, help="Requested camera frame rate, for example 60 if the camera supports it at this resolution")
    parser.add_argument("--min-confidence", type=float, default=.2, help="Swipe: reject squares below this quality (square side / 40 px); default 0.2 = 8 px")
    parser.add_argument("--media-url", help="Local-network URL for the image or video shown by Swipe")
    parser.add_argument("--media-kind", choices=("image", "video"), default="image")
    parser.add_argument("--media-width", type=int, default=1600)
    parser.add_argument("--media-height", type=int, default=1000)
    parser.add_argument("--media-version", type=int, default=1)
    parser.add_argument("--media-position", type=float, default=0)
    parser.add_argument("--check-distance-cm", type=float, help="Known screen-centre distance measured with a ruler; shows live error")
    parser.add_argument("--check-angle-deg", type=float, help="Known B-minus-A angle, anticlockwise; shows live error")
    args = parser.parse_args()
    if args.calibration is None:
        args.calibration = str(ROOT / ('swipe-calibration.json' if args.command in ('swipe', 'calibrate-manual') else 'calibration.json'))
    if args.command == "devices":
        list_devices()
        return
    config = load_config(args.config)
    if args.marker_cm is not None:
        config['screen_marker_cm'] = args.marker_cm
        check_screen_marker(config)
    if args.command == "markers":
        print_markers(config, Path(args.output))
    elif args.command == "calibrate":
        calibrate(args, config)
    elif args.command in ('calibrate-manual', 'swipe'):
        if args.command == 'swipe' and not args.manual_area:
            while asyncio.run(run(args, config)):
                pass
            return
        needs_setup = args.command == 'calibrate-manual' or args.recalibrate or not Path(args.calibration).exists()
        while True:
            if needs_setup:
                if args.headless:
                    raise ValueError('Draw the Swipe area without --headless first')
                cap = open_camera(args.camera)
                try:
                    if not calibrate_manual(cap, args, config):
                        return
                finally:
                    cap.release()
                if args.command == 'calibrate-manual':
                    return
            if not asyncio.run(run(args, config)):
                break
            needs_setup = True
    else:
        asyncio.run(run(args, config))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        raise SystemExit(str(error)) from error
    except KeyboardInterrupt:
        pass
