import CoreMotion
import ExpoModulesCore
import Foundation
import MultipeerConnectivity
import NearbyInteraction
import UIKit
import simd

private struct ParallaxVector3: Codable {
  let x: Double
  let y: Double
  let z: Double
}

private struct ParallaxQuaternion: Codable {
  let x: Double
  let y: Double
  let z: Double
  let w: Double
}

private struct ParallaxMotion: Codable {
  let role: String
  let attitudeQuaternion: ParallaxQuaternion?
  let yaw: Double?
  let pitch: Double?
  let roll: Double?
  let gravity: ParallaxVector3?
  let angularVelocity: ParallaxVector3?
  let referenceFrame: String
  let commonFrameAvailable: Bool
  let valid: Bool
  let timestamp: Double
  let motionTimestamp: Double?
  let userAcceleration: ParallaxVector3?
  let displacementCm: ParallaxVector3?
  let stationary: Bool?
  let movingSeconds: Double?
  /** Start time of this phone's Core Motion run; headings from different runs are not comparable. */
  var frameId: Double? = nil
}

private struct ParallaxTelemetry: Codable {
  let version: Int
  let role: String
  let distanceCm: Double?
  let distanceAvailable: Bool
  let direction: ParallaxVector3?
  let directionAvailable: Bool
  let directionValid: Bool
  let horizontalAngleRad: Double?
  let horizontalAngleAvailable: Bool
  let timestamp: Double
  let sessionState: String
  let motion: ParallaxMotion?
}

private struct ParallaxWireEnvelope: Codable {
  let version: Int
  let kind: String
  let token: Data?
  let telemetry: ParallaxTelemetry?
  /** Opaque JSON from the JavaScript layer, such as a shared spin result. */
  var message: String? = nil
  /** Motion snapshot sent on its own cadence, independent of UWB updates. */
  var motion: ParallaxMotion? = nil
}

public final class ParallaxModule: Module {
  private let serviceType = "parallax-uwb"
  private lazy var multipeerDelegate = ParallaxMultipeerDelegate(owner: self)
  private lazy var nearbyInteractionDelegate = ParallaxNearbyInteractionDelegate(owner: self)
  private let motionManager = CMMotionManager()
  private var browser: MCNearbyServiceBrowser?
  private var advertiser: MCNearbyServiceAdvertiser?
  private var session: MCSession?
  private var niSession: NISession?
  private var peers: [String: MCPeerID] = [:]
  private var selectedPeer: MCPeerID?
  private var distanceUpdateCount = 0
  private var localRole = "unknown"
  private var rangingActive = false
  private var motionReferenceFrame: CMAttitudeReferenceFrame?
  private var motionReferenceFrameName = "unavailable"
  private var magneticNorthAvailable = false
  // Dead reckoning of the phone's own slide across the table, in the reference frame (metres).
  private let standardGravity = 9.80665
  private let stillAccelerationG = 0.025
  private let stillRotationRate = 0.2
  private let stillDuration = 0.15
  private var latestDeviceMotion: CMDeviceMotion?
  private var lastMotionTimestamp: TimeInterval?
  private var velocity = SIMD2<Double>(repeating: 0)
  private var displacement = SIMD2<Double>(repeating: 0)
  private var stillSince: TimeInterval?
  private var stationary = true
  private var movingSeconds = 0.0
  private var motionFrameId: Double?
  private var lastMotionPublish: TimeInterval?
  /** Motion is published to JavaScript and the other phone at about 20 Hz, whatever UWB is doing. */
  private let motionPublishInterval = 0.05

  public func definition() -> ModuleDefinition {
    Name("ParallaxModule")
    Events("peerDiscovered", "connectionChanged", "distanceUpdated", "motionUpdated", "peerMessage", "error", "diagnostic")

    AsyncFunction("startDiscovery") { [weak self] in self?.startDiscovery() }
    AsyncFunction("stopDiscovery") { [weak self] in self?.stopDiscovery() }
    AsyncFunction("connect") { [weak self] (peerId: String) in try self?.connect(peerId: peerId) }
    AsyncFunction("disconnect") { [weak self] in self?.disconnect() }
    AsyncFunction("startRanging") { [weak self] in try self?.startRanging() }
    AsyncFunction("stopRanging") { [weak self] in self?.stopRanging() }
    AsyncFunction("getCapabilities") { [weak self] in self?.capabilities() ?? [:] }
    AsyncFunction("sendPeerMessage") { [weak self] (message: String) in try self?.sendPeerMessage(message) }
    AsyncFunction("startMotion") { [weak self] in self?.startMotionUpdates() }
    AsyncFunction("stopMotion") { [weak self] in self?.stopMotionIfIdle() }
  }

  private func sendPeerMessage(_ message: String) throws {
    guard let peer = selectedPeer else {
      throw NSError(domain: "Parallax", code: 8, userInfo: [NSLocalizedDescriptionKey: "No connected phone to send to"])
    }
    try sendEnvelope(ParallaxWireEnvelope(version: 1, kind: "message", token: nil, telemetry: nil, message: message), to: peer)
  }

  private func startDiscovery() {
    let localPeer = MCPeerID(displayName: UIDevice.current.name)
    localRole = "unknown"
    distanceUpdateCount = 0
    prepareMotionReferenceFrame()
    diagnostic("discovery", "Starting as \(localPeer.displayName); role assigned when connection begins")

    let mcSession = MCSession(peer: localPeer, securityIdentity: nil, encryptionPreference: .required)
    mcSession.delegate = multipeerDelegate
    session = mcSession

    let nextBrowser = MCNearbyServiceBrowser(peer: localPeer, serviceType: serviceType)
    nextBrowser.delegate = multipeerDelegate
    browser = nextBrowser

    let nextAdvertiser = MCNearbyServiceAdvertiser(peer: localPeer, discoveryInfo: nil, serviceType: serviceType)
    nextAdvertiser.delegate = multipeerDelegate
    advertiser = nextAdvertiser

    nextBrowser.startBrowsingForPeers()
    nextAdvertiser.startAdvertisingPeer()
    diagnostic("discovery", "Browsing and advertising started for \(serviceType)")
    sendConnection(state: "disconnected")
  }

  private func stopDiscovery() {
    diagnostic("discovery", "Stopping browsing and advertising")
    stopMotionUpdates()
    browser?.stopBrowsingForPeers()
    advertiser?.stopAdvertisingPeer()
    browser = nil
    advertiser = nil
    session?.disconnect()
    session = nil
    peers.removeAll()
    selectedPeer = nil
    rangingActive = false
    localRole = "unknown"
  }

  private func connect(peerId: String) throws {
    guard let peer = peers[peerId], let browser, let session else {
      diagnostic("multipeer", "Connect requested for unavailable peer \(peerId)")
      throw NSError(domain: "Parallax", code: 1, userInfo: [NSLocalizedDescriptionKey: "Peer is no longer available"])
    }

    localRole = "A"
    selectedPeer = peer
    diagnostic("multipeer", "Inviting \(peer.displayName) as Phone A")
    sendConnection(state: "connecting", peer: peer)
    browser.invitePeer(peer, to: session, withContext: nil, timeout: 15)
  }

  private func disconnect() {
    diagnostic("multipeer", "Disconnect requested")
    stopRanging()
    stopMotionUpdates()
    niSession?.invalidate()
    niSession = nil
    session?.disconnect()
    selectedPeer = nil
    localRole = "unknown"
    sendConnection(state: "disconnected")
  }

  private func makeNISessionIfNeeded() throws -> NISession {
    guard NISession.deviceCapabilities.supportsPreciseDistanceMeasurement else {
      throw NSError(domain: "Parallax", code: 3, userInfo: [NSLocalizedDescriptionKey: "Nearby Interaction is not supported on this device"])
    }

    if let niSession { return niSession }
    let nextSession = NISession()
    nextSession.delegate = nearbyInteractionDelegate
    niSession = nextSession
    return nextSession
  }

  private func startRanging() throws {
    guard let session else {
      diagnostic("nearby", "Cannot start ranging: Multipeer session is unavailable")
      throw NSError(domain: "Parallax", code: 2, userInfo: [NSLocalizedDescriptionKey: "Connect to a peer before ranging"])
    }

    let peer = session.connectedPeers.first(where: { $0 == selectedPeer }) ?? session.connectedPeers.first
    guard let peer else {
      diagnostic("nearby", "Cannot start ranging: connectedPeers is empty")
      throw NSError(domain: "Parallax", code: 6, userInfo: [NSLocalizedDescriptionKey: "Peers are not connected yet"])
    }
    selectedPeer = peer
    _ = try makeNISessionIfNeeded()
    startMotionUpdates()
    rangingActive = true
    sendConnection(state: "connected", peer: peer, sessionState: "ranging")

    guard let token = niSession?.discoveryToken else {
      diagnostic("nearby", "NISession has no discovery token yet")
      throw NSError(domain: "Parallax", code: 4, userInfo: [NSLocalizedDescriptionKey: "Nearby Interaction did not provide a discovery token"])
    }

    diagnostic("nearby", "Starting ranging with \(peer.displayName); preciseDistance=\(NISession.deviceCapabilities.supportsPreciseDistanceMeasurement) direction=\(NISession.deviceCapabilities.supportsDirectionMeasurement)")
    do {
      try sendEnvelope(ParallaxWireEnvelope(version: 1, kind: "discoveryToken", token: try archiveToken(token), telemetry: nil), to: peer)
      diagnostic("nearby", "Discovery token sent to \(peer.displayName)")
    } catch {
      fail(error, code: "token_send_failed")
      throw error
    }
  }

  private func stopRanging() {
    rangingActive = false
    niSession?.invalidate()
    niSession = nil
  }

  private func archiveToken(_ token: NIDiscoveryToken) throws -> Data {
    try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
  }

  private func sendEnvelope(_ envelope: ParallaxWireEnvelope, to peer: MCPeerID, mode: MCSessionSendDataMode = .reliable) throws {
    guard let session else { throw NSError(domain: "Parallax", code: 7, userInfo: [NSLocalizedDescriptionKey: "Multipeer session is unavailable"]) }
    try session.send(JSONEncoder().encode(envelope), toPeers: [peer], with: mode)
  }

  fileprivate func receiveData(_ data: Data, from peerID: MCPeerID) {
    if let envelope = try? JSONDecoder().decode(ParallaxWireEnvelope.self, from: data), envelope.version == 1 {
      if envelope.kind == "discoveryToken", let tokenData = envelope.token {
        receiveDiscoveryToken(tokenData, from: peerID)
      } else if envelope.kind == "telemetry", let telemetry = envelope.telemetry {
        receiveTelemetry(telemetry, from: peerID)
      } else if envelope.kind == "message", let message = envelope.message {
        sendEvent("peerMessage", ["peerId": peerID.displayName, "message": message])
      } else if envelope.kind == "motion", let motion = envelope.motion {
        sendEvent("motionUpdated", motionDictionary(motion, source: "remote", peerId: peerID.displayName))
      }
      return
    }
    receiveDiscoveryToken(data, from: peerID)
  }

  fileprivate func receiveDiscoveryToken(_ data: Data, from peerID: MCPeerID) {
    diagnostic("nearby", "Received discovery token data (\(data.count) bytes) from \(peerID.displayName)")
    do {
      guard let token = try NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self, from: data) else {
        throw NSError(domain: "Parallax", code: 5, userInfo: [NSLocalizedDescriptionKey: "Received an empty Nearby Interaction token"])
      }

      if localRole != "A" { localRole = "B" }
      selectedPeer = peerID
      diagnostic("nearby", "Discovery token decoded as Phone \(localRole); running peer configuration")
      let nearbySession = try makeNISessionIfNeeded()
      nearbySession.run(NINearbyPeerConfiguration(peerToken: token))
      diagnostic("nearby", "NISession.run completed")
    } catch {
      fail(error, code: "token_exchange_failed")
    }
  }

  fileprivate func fail(_ error: Error, code: String = "native_error") {
    sendEvent("error", ["code": code, "message": error.localizedDescription, "recoverable": true])
  }

  fileprivate func foundPeer(_ peerID: MCPeerID) {
    peers[peerID.displayName] = peerID
    diagnostic("discovery", "Found peer \(peerID.displayName)")
    sendEvent("peerDiscovered", ["id": peerID.displayName, "name": peerID.displayName])
  }

  fileprivate func lostPeer(_ peerID: MCPeerID) {
    peers.removeValue(forKey: peerID.displayName)
    diagnostic("discovery", "Lost peer \(peerID.displayName)")
  }

  fileprivate func acceptInvitation(from peerID: MCPeerID, _ handler: @escaping (Bool, MCSession?) -> Void) {
    if localRole != "A" { localRole = "B" }
    selectedPeer = peerID
    diagnostic("multipeer", "Accepted invitation from \(peerID.displayName) as Phone \(localRole)")
    handler(true, session)
  }

  fileprivate func connectionChanged(_ state: MCSessionState, peer: MCPeerID) {
    if state == .connected {
      selectedPeer = peer
      if localRole == "unknown" { localRole = "B" }
      // Headings are needed for joining before ranging starts, and must not restart while connected.
      startMotionUpdates()
    } else if state == .notConnected, session?.connectedPeers.isEmpty ?? true {
      stopMotionUpdates()
    }
    let value = state == .connected ? "connected" : state == .connecting ? "connecting" : "disconnected"
    let connectedNames = session?.connectedPeers.map(\.displayName).joined(separator: ", ") ?? "none"
    diagnostic("multipeer", "Peer \(peer.displayName) state changed to \(value); role=\(localRole); connectedPeers=\(connectedNames)")
    sendConnection(state: value, peer: peer)
  }

  fileprivate func distanceUpdated(_ nearbyObjects: [NINearbyObject]) {
    guard let object = nearbyObjects.first else { return }
    let now = Date().timeIntervalSince1970 * 1000
    let distanceCm = object.distance.map { Double($0) * 100 }
    let direction = object.direction.map { ParallaxVector3(x: Double($0.x), y: Double($0.y), z: Double($0.z)) }
    let directionValid = direction.map { valid($0) && sqrt($0.x * $0.x + $0.y * $0.y + $0.z * $0.z) > 0.000001 } ?? false
    let horizontalAngle = object.horizontalAngle.map(Double.init)
    let sessionState = rangingActive ? "ranging" : "connected"
    distanceUpdateCount += 1

    if distanceUpdateCount == 1 || distanceUpdateCount % 20 == 0 {
      diagnostic("nearby", "Measurement \(distanceUpdateCount): distance=\(distanceCm.map { String(format: "%.1f", $0) } ?? "unavailable") cm direction=\(directionValid ? "valid" : "unavailable") angle=\(horizontalAngle != nil ? "available" : "unavailable")")
    }

    let payload: [String: Any] = [
      "peerId": selectedPeer?.displayName as Any,
      "role": localRole,
      "source": "measured",
      "distanceCm": distanceCm as Any,
      "distanceAvailable": distanceCm != nil,
      "direction": direction.map(dictionary) as Any,
      "directionAvailable": direction != nil,
      "directionValid": directionValid,
      "horizontalAngleRad": horizontalAngle as Any,
      "horizontalAngleAvailable": horizontalAngle != nil,
      "timestamp": now,
      "measurementTimestamp": now,
      "sessionState": sessionState
    ]
    sendEvent("distanceUpdated", payload)

    // JSONEncoder throws on NaN or infinity, which would drop the whole telemetry packet.
    let telemetry = ParallaxTelemetry(
      version: 1,
      role: localRole,
      distanceCm: distanceCm,
      distanceAvailable: distanceCm != nil,
      direction: direction.flatMap { valid($0) ? $0 : nil },
      directionAvailable: direction != nil,
      directionValid: directionValid,
      horizontalAngleRad: horizontalAngle,
      horizontalAngleAvailable: horizontalAngle != nil,
      timestamp: now,
      sessionState: sessionState,
      motion: nil
    )
    if let peer = selectedPeer {
      do {
        try sendEnvelope(ParallaxWireEnvelope(version: 1, kind: "telemetry", token: nil, telemetry: telemetry), to: peer)
      } catch {
        fail(error, code: "telemetry_send_failed")
      }
    }
  }

  private func receiveTelemetry(_ telemetry: ParallaxTelemetry, from peerID: MCPeerID) {
    let payload: [String: Any] = [
      "peerId": peerID.displayName,
      "role": telemetry.role,
      "source": "measured",
      "distanceCm": telemetry.distanceCm as Any,
      "distanceAvailable": telemetry.distanceAvailable,
      "direction": telemetry.direction.map(dictionary) as Any,
      "directionAvailable": telemetry.directionAvailable,
      "directionValid": telemetry.directionValid,
      "horizontalAngleRad": telemetry.horizontalAngleRad as Any,
      "horizontalAngleAvailable": telemetry.horizontalAngleAvailable,
      "timestamp": telemetry.timestamp,
      "measurementTimestamp": telemetry.timestamp,
      "sessionState": telemetry.sessionState
    ]
    sendEvent("distanceUpdated", payload)
    if let motion = telemetry.motion { sendEvent("motionUpdated", motionDictionary(motion, source: "remote", peerId: peerID.displayName)) }
    diagnostic("telemetry", "Received Phone \(telemetry.role) measurement from \(peerID.displayName)")
  }

  /// Gyro-only yaw. Magnetic frames keep pulling the heading towards what the magnetometer reads,
  /// and next to another phone's MagSafe magnets that is wrong and changes as the phones move.
  /// The two phones' arbitrary frames are tied together by the swipe join in JavaScript instead.
  private func prepareMotionReferenceFrame() {
    let available = CMMotionManager.availableAttitudeReferenceFrames()
    magneticNorthAvailable = available.contains(.xMagneticNorthZVertical)
    if available.contains(.xArbitraryZVertical) {
      motionReferenceFrame = .xArbitraryZVertical
      motionReferenceFrameName = "xArbitraryZVertical"
    } else {
      motionReferenceFrame = nil
      motionReferenceFrameName = "unavailable"
    }
  }

  private func startMotionUpdates() {
    // Restarting would move the arbitrary frame's yaw zero and break any join made in it.
    guard !motionManager.isDeviceMotionActive else { return }
    prepareMotionReferenceFrame()
    guard motionManager.isDeviceMotionAvailable else {
      diagnostic("motion", "Device motion is unavailable")
      return
    }
    resetDeadReckoning()
    motionFrameId = Date().timeIntervalSince1970 * 1000
    lastMotionPublish = nil
    motionManager.deviceMotionUpdateInterval = 1.0 / 100.0
    // Delivered on the main queue, where Nearby Interaction callbacks also run, so the state needs no lock.
    let handler: CMDeviceMotionHandler = { [weak self] data, _ in
      guard let self, let data else { return }
      self.integrate(data)
      self.publishMotionIfDue(data.timestamp)
    }
    if let frame = motionReferenceFrame { motionManager.startDeviceMotionUpdates(using: frame, to: .main, withHandler: handler) }
    else { motionManager.startDeviceMotionUpdates(to: .main, withHandler: handler) }
    diagnostic("motion", "Started device motion with \(motionReferenceFrameName); magneticNorth=\(magneticNorthAvailable)")
  }

  /// Swipe senses movement without a peer, so leaving it must not stop motion a connected link still needs.
  private func stopMotionIfIdle() {
    if session?.connectedPeers.isEmpty ?? true { stopMotionUpdates() }
  }

  private func stopMotionUpdates() {
    if motionManager.isDeviceMotionActive { motionManager.stopDeviceMotionUpdates() }
    motionFrameId = nil
  }

  /// Sends the latest motion to JavaScript and, unreliably so a stall cannot queue stale poses, to the other phone.
  private func publishMotionIfDue(_ timestamp: TimeInterval) {
    if let last = lastMotionPublish, timestamp - last < motionPublishInterval { return }
    lastMotionPublish = timestamp
    guard let motion = currentMotion(role: localRole) else { return }
    sendEvent("motionUpdated", motionDictionary(motion, source: "local", peerId: selectedPeer?.displayName))
    guard motion.valid, let peer = selectedPeer, session?.connectedPeers.contains(peer) == true else { return }
    var envelope = ParallaxWireEnvelope(version: 1, kind: "motion", token: nil, telemetry: nil)
    envelope.motion = motion
    _ = try? sendEnvelope(envelope, to: peer, mode: .unreliable)
  }

  private func resetDeadReckoning() {
    latestDeviceMotion = nil
    lastMotionTimestamp = nil
    velocity = .zero
    displacement = .zero
    stillSince = nil
    stationary = true
    movingSeconds = 0
  }

  /// Integrates user acceleration, rotated into the reference frame, twice. Velocity is zeroed
  /// whenever the phone has been still briefly, so drift only builds up while it is moving.
  private func integrate(_ data: CMDeviceMotion) {
    latestDeviceMotion = data
    defer { lastMotionTimestamp = data.timestamp }
    guard let last = lastMotionTimestamp else { return }
    let dt = data.timestamp - last
    guard dt > 0, dt < 0.1 else { return }

    let user = data.userAcceleration
    let rate = data.rotationRate
    let accelerationG = sqrt(user.x * user.x + user.y * user.y + user.z * user.z)
    let rotationRate = sqrt(rate.x * rate.x + rate.y * rate.y + rate.z * rate.z)
    guard accelerationG.isFinite, rotationRate.isFinite else { return }
    if accelerationG < stillAccelerationG && rotationRate < stillRotationRate {
      stillSince = stillSince ?? data.timestamp
    } else {
      stillSince = nil
    }
    stationary = stillSince.map { data.timestamp - $0 >= stillDuration } ?? false
    if stationary {
      velocity = .zero
      return
    }

    // Same convention as the JavaScript spatial layer: v_ref = q · v · q*.
    let q = data.attitude.quaternion
    let world = simd_quatd(ix: q.x, iy: q.y, iz: q.z, r: q.w).act(SIMD3(user.x, user.y, user.z) * standardGravity)
    velocity += SIMD2(world.x, world.y) * dt
    displacement += velocity * dt
    movingSeconds += dt
  }

  private func currentMotion(role: String) -> ParallaxMotion? {
    guard let data = latestDeviceMotion else { return nil }
    let attitude = data.attitude.quaternion
    let user = data.userAcceleration
    let finite = [attitude.x, attitude.y, attitude.z, attitude.w, data.gravity.x, data.gravity.y, data.gravity.z, user.x, user.y, user.z, displacement.x, displacement.y]
      .allSatisfy(\.isFinite)
    return ParallaxMotion(
      role: role,
      attitudeQuaternion: ParallaxQuaternion(x: attitude.x, y: attitude.y, z: attitude.z, w: attitude.w),
      yaw: data.attitude.yaw,
      pitch: data.attitude.pitch,
      roll: data.attitude.roll,
      gravity: ParallaxVector3(x: data.gravity.x, y: data.gravity.y, z: data.gravity.z),
      angularVelocity: ParallaxVector3(x: data.rotationRate.x, y: data.rotationRate.y, z: data.rotationRate.z),
      referenceFrame: motionReferenceFrameName,
      commonFrameAvailable: false,
      valid: finite,
      timestamp: Date().timeIntervalSince1970 * 1000,
      motionTimestamp: data.timestamp,
      userAcceleration: ParallaxVector3(x: user.x, y: user.y, z: user.z),
      displacementCm: ParallaxVector3(x: displacement.x * 100, y: displacement.y * 100, z: 0),
      stationary: stationary,
      movingSeconds: movingSeconds,
      frameId: motionFrameId
    )
  }

  private func capabilities() -> [String: Any] {
    prepareMotionReferenceFrame()
    return [
      "uwbSupported": NISession.deviceCapabilities.supportsPreciseDistanceMeasurement,
      "directionMayBeAvailable": NISession.deviceCapabilities.supportsDirectionMeasurement,
      "deviceMotionAvailable": motionManager.isDeviceMotionAvailable,
      "magneticNorthAvailable": magneticNorthAvailable,
      "selectedReferenceFrame": motionReferenceFrameName,
      "cameraAssistanceSupported": NISession.deviceCapabilities.supportsCameraAssistance,
      "cameraAssistance": "not_used"
    ]
  }

  private func sendConnection(state: String, peer: MCPeerID? = nil, sessionState: String? = nil) {
    sendEvent("connectionChanged", [
      "state": state,
      "peerId": peer?.displayName as Any,
      "role": localRole,
      "sessionState": sessionState ?? (state == "connected" ? "connected" : "idle")
    ])
  }

  private func valid(_ vector: ParallaxVector3) -> Bool {
    vector.x.isFinite && vector.y.isFinite && vector.z.isFinite
  }

  private func dictionary(_ vector: ParallaxVector3) -> [String: Double] {
    ["x": vector.x, "y": vector.y, "z": vector.z]
  }

  private func motionDictionary(_ motion: ParallaxMotion, source: String, peerId: String?) -> [String: Any] {
    [
      "peerId": peerId as Any,
      "role": motion.role,
      "source": source,
      "attitudeQuaternion": motion.attitudeQuaternion.map { ["x": $0.x, "y": $0.y, "z": $0.z, "w": $0.w] } as Any,
      "yaw": motion.yaw as Any,
      "pitch": motion.pitch as Any,
      "roll": motion.roll as Any,
      "gravity": motion.gravity.map(dictionary) as Any,
      "angularVelocity": motion.angularVelocity.map(dictionary) as Any,
      "referenceFrame": motion.referenceFrame,
      "commonFrameAvailable": motion.commonFrameAvailable,
      "valid": motion.valid,
      "timestamp": motion.timestamp,
      "motionTimestamp": motion.motionTimestamp as Any,
      "userAcceleration": motion.userAcceleration.map(dictionary) as Any,
      "displacementCm": motion.displacementCm.map(dictionary) as Any,
      "stationary": motion.stationary as Any,
      "movingSeconds": motion.movingSeconds as Any,
      "frameId": motion.frameId as Any
    ]
  }

  fileprivate func sessionWasSuspended() {
    diagnostic("nearby", "NISession suspended")
    sendConnection(state: "recovering", sessionState: "recovering")
  }

  fileprivate func sessionSuspensionEnded(_ session: NISession) {
    diagnostic("nearby", "NISession suspension ended; re-exchanging token")
    guard let peer = selectedPeer, let token = session.discoveryToken else { return }
    do {
      try sendEnvelope(ParallaxWireEnvelope(version: 1, kind: "discoveryToken", token: try archiveToken(token), telemetry: nil), to: peer)
      sendConnection(state: "connected", peer: peer, sessionState: rangingActive ? "ranging" : "connected")
    }
    catch { fail(error, code: "recovery_failed") }
  }

  fileprivate func nearbyInteractionInvalidated(_ session: NISession, _ error: Error) {
    diagnostic("nearby", "NISession invalidated: \(error.localizedDescription)")
    // An invalidated session cannot run again; drop it so the next startRanging creates a fresh one.
    if session === niSession {
      niSession = nil
      rangingActive = false
    }
    let peerConnected = selectedPeer.map { self.session?.connectedPeers.contains($0) ?? false } ?? false
    sendConnection(state: peerConnected ? "connected" : "disconnected", peer: selectedPeer, sessionState: "invalidated")
    fail(error, code: "ni_invalidated")
  }

  private func diagnostic(_ stage: String, _ message: String) {
    sendEvent("diagnostic", ["stage": stage, "message": message, "timestamp": Date().timeIntervalSince1970 * 1000])
  }
}

private final class ParallaxMultipeerDelegate: NSObject, MCNearbyServiceBrowserDelegate, MCNearbyServiceAdvertiserDelegate, MCSessionDelegate {
  weak var owner: ParallaxModule?
  init(owner: ParallaxModule) { self.owner = owner }

  func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) { owner?.foundPeer(peerID) }
  func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) { owner?.lostPeer(peerID) }
  func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) { owner?.fail(error, code: "discovery_failed") }
  func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) { owner?.acceptInvitation(from: peerID, invitationHandler) }
  func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) { owner?.fail(error, code: "advertising_failed") }
  func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) { owner?.connectionChanged(state, peer: peerID) }
  func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) { owner?.receiveData(data, from: peerID) }
  func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
  func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
  func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

private final class ParallaxNearbyInteractionDelegate: NSObject, NISessionDelegate {
  weak var owner: ParallaxModule?
  init(owner: ParallaxModule) { self.owner = owner }
  func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) { owner?.distanceUpdated(nearbyObjects) }
  func session(_ session: NISession, didUpdateAlgorithmConvergence convergence: NIAlgorithmConvergence) {}
  func sessionWasSuspended(_ session: NISession) { owner?.sessionWasSuspended() }
  func sessionSuspensionEnded(_ session: NISession) { owner?.sessionSuspensionEnded(session) }
  func session(_ session: NISession, didInvalidateWith error: Error) { owner?.nearbyInteractionInvalidated(session, error) }
}
