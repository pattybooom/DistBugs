import ExpoModulesCore
import Foundation
import MultipeerConnectivity
import NearbyInteraction
import UIKit

public final class ParallaxModule: Module {
  private let serviceType = "parallax-uwb"
  private lazy var multipeerDelegate = ParallaxMultipeerDelegate(owner: self)
  private lazy var nearbyInteractionDelegate = ParallaxNearbyInteractionDelegate(owner: self)
  private var browser: MCNearbyServiceBrowser?
  private var advertiser: MCNearbyServiceAdvertiser?
  private var session: MCSession?
  private var niSession: NISession?
  private var peers: [String: MCPeerID] = [:]
  private var selectedPeer: MCPeerID?
  private var distanceUpdateCount = 0

  public func definition() -> ModuleDefinition {
    Name("ParallaxModule")
    Events("peerDiscovered", "connectionChanged", "distanceUpdated", "error", "diagnostic")

    AsyncFunction("startDiscovery") { [weak self] in self?.startDiscovery() }
    AsyncFunction("stopDiscovery") { [weak self] in self?.stopDiscovery() }
    AsyncFunction("connect") { [weak self] (peerId: String) in try self?.connect(peerId: peerId) }
    AsyncFunction("disconnect") { [weak self] in self?.disconnect() }
    AsyncFunction("startRanging") { [weak self] in try self?.startRanging() }
    AsyncFunction("stopRanging") { [weak self] in
      self?.niSession?.invalidate()
      self?.niSession = nil
    }
  }

  private func startDiscovery() {
    let localPeer = MCPeerID(displayName: UIDevice.current.name)
    diagnostic("discovery", "Starting as \(localPeer.displayName)")
    let mcSession = MCSession(peer: localPeer, securityIdentity: nil, encryptionPreference: .required)
    mcSession.delegate = multipeerDelegate
    session = mcSession

    let nextBrowser = MCNearbyServiceBrowser(peer: localPeer, serviceType: serviceType)
    nextBrowser.delegate = multipeerDelegate
    browser = nextBrowser

    let nextAdvertiser = MCNearbyServiceAdvertiser(
      peer: localPeer,
      discoveryInfo: nil,
      serviceType: serviceType
    )
    nextAdvertiser.delegate = multipeerDelegate
    advertiser = nextAdvertiser

    nextBrowser.startBrowsingForPeers()
    nextAdvertiser.startAdvertisingPeer()
    diagnostic("discovery", "Browsing and advertising started for \(serviceType)")
    sendEvent("connectionChanged", ["state": "disconnected"])
  }

  private func stopDiscovery() {
    diagnostic("discovery", "Stopping browsing and advertising")
    browser?.stopBrowsingForPeers()
    advertiser?.stopAdvertisingPeer()
    browser = nil
    advertiser = nil
    session?.disconnect()
    session = nil
    peers.removeAll()
  }

  private func connect(peerId: String) throws {
    guard let peer = peers[peerId], let browser, let session else {
      diagnostic("multipeer", "Connect requested for unavailable peer \(peerId)")
      throw NSError(domain: "Parallax", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "Peer is no longer available"
      ])
    }

    selectedPeer = peer
    diagnostic("multipeer", "Inviting \(peer.displayName)")
    sendEvent("connectionChanged", ["state": "connecting"])
    browser.invitePeer(peer, to: session, withContext: nil, timeout: 15)
  }

  private func disconnect() {
    diagnostic("multipeer", "Disconnect requested")
    niSession?.invalidate()
    niSession = nil
    session?.disconnect()
    selectedPeer = nil
    sendEvent("connectionChanged", ["state": "disconnected"])
  }

  private func makeNISessionIfNeeded() throws -> NISession {
    guard NISession.isSupported else {
      throw NSError(domain: "Parallax", code: 3, userInfo: [
        NSLocalizedDescriptionKey: "Nearby Interaction is not supported on this device"
      ])
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
      throw NSError(domain: "Parallax", code: 2, userInfo: [
        NSLocalizedDescriptionKey: "Connect to a peer before ranging"
      ])
    }

    let peer = session.connectedPeers.first(where: { $0 == selectedPeer }) ?? session.connectedPeers.first
    guard let peer else {
      diagnostic("nearby", "Cannot start ranging: connectedPeers is empty")
      throw NSError(domain: "Parallax", code: 6, userInfo: [
        NSLocalizedDescriptionKey: "Peers are not connected yet"
      ])
    }
    selectedPeer = peer

    diagnostic("nearby", "Starting ranging with \(peer.displayName); NI supported=\(NISession.isSupported)")
    let nearbySession = try makeNISessionIfNeeded()
    guard let token = nearbySession.discoveryToken else {
      diagnostic("nearby", "NISession has no discovery token yet")
      throw NSError(domain: "Parallax", code: 4, userInfo: [
        NSLocalizedDescriptionKey: "Nearby Interaction did not provide a discovery token"
      ])
    }

    let data = try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
    diagnostic("nearby", "Sending discovery token (\(data.count) bytes) to \(peer.displayName)")
    do {
      try session.send(data, toPeers: [peer], with: .reliable)
      diagnostic("nearby", "Discovery token sent")
    } catch {
      fail(error, code: "token_send_failed")
      throw error
    }
  }

  fileprivate func receiveDiscoveryToken(_ data: Data, from peerID: MCPeerID) {
    diagnostic("nearby", "Received discovery token data (\(data.count) bytes) from \(peerID.displayName)")
    do {
      guard let token = try NSKeyedUnarchiver.unarchivedObject(
        ofClass: NIDiscoveryToken.self,
        from: data
      ) else {
        throw NSError(domain: "Parallax", code: 5, userInfo: [
          NSLocalizedDescriptionKey: "Received an empty Nearby Interaction token"
        ])
      }

      selectedPeer = peerID
      diagnostic("nearby", "Discovery token decoded; running peer configuration")
      let nearbySession = try makeNISessionIfNeeded()
      nearbySession.run(NINearbyPeerConfiguration(peerToken: token))
      diagnostic("nearby", "NISession.run completed")
    } catch {
      fail(error, code: "token_exchange_failed")
    }
  }

  fileprivate func fail(_ error: Error, code: String = "native_error") {
    sendEvent("error", [
      "code": code,
      "message": error.localizedDescription,
      "recoverable": true
    ])
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
    selectedPeer = peerID
    diagnostic("multipeer", "Accepted invitation from \(peerID.displayName)")
    handler(true, session)
  }

  fileprivate func connectionChanged(_ state: MCSessionState, peer: MCPeerID) {
    if state == .connected {
      selectedPeer = peer
    }
    let value = state == .connected ? "connected" : state == .connecting ? "connecting" : "disconnected"
    let connectedNames = session?.connectedPeers.map(\.displayName).joined(separator: ", ") ?? "none"
    diagnostic("multipeer", "Peer \(peer.displayName) state changed to \(value); connectedPeers=\(connectedNames)")
    sendEvent("connectionChanged", ["state": value])
  }

  fileprivate func distanceUpdated(_ nearbyObjects: [NINearbyObject]) {
    guard let object = nearbyObjects.first, let distance = object.distance else { return }
    distanceUpdateCount += 1
    if distanceUpdateCount == 1 || distanceUpdateCount % 20 == 0 {
      diagnostic("nearby", "Distance update #\(distanceUpdateCount): \(distance * 100) cm")
    }
    sendEvent("distanceUpdated", [
      "distanceCm": distance * 100,
      "timestamp": Date().timeIntervalSince1970 * 1000,
      "direction": object.direction.map { ["x": $0.x, "y": $0.y, "z": $0.z] } as Any
    ])
  }

  fileprivate func sessionWasSuspended() {
    diagnostic("nearby", "NISession suspended")
    sendEvent("connectionChanged", ["state": "recovering"])
  }

  fileprivate func sessionSuspensionEnded(_ session: NISession) {
    diagnostic("nearby", "NISession suspension ended; re-exchanging token")
    guard let peer = selectedPeer, let token = session.discoveryToken else { return }

    do {
      let data = try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
      try self.session?.send(data, toPeers: [peer], with: .reliable)
    } catch {
      fail(error, code: "recovery_failed")
    }
  }

  fileprivate func nearbyInteractionInvalidated(_ error: Error) {
    diagnostic("nearby", "NISession invalidated: \(error.localizedDescription)")
    sendEvent("error", [
      "code": "ni_invalidated",
      "message": error.localizedDescription,
      "recoverable": true
    ])
  }

  private func diagnostic(_ stage: String, _ message: String) {
    sendEvent("diagnostic", [
      "stage": stage,
      "message": message,
      "timestamp": Date().timeIntervalSince1970 * 1000
    ])
  }
}

private final class ParallaxMultipeerDelegate: NSObject,
  MCNearbyServiceBrowserDelegate,
  MCNearbyServiceAdvertiserDelegate,
  MCSessionDelegate {
  weak var owner: ParallaxModule?

  init(owner: ParallaxModule) {
    self.owner = owner
  }

  func browser(
    _ browser: MCNearbyServiceBrowser,
    foundPeer peerID: MCPeerID,
    withDiscoveryInfo info: [String: String]?
  ) {
    owner?.foundPeer(peerID)
  }

  func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
    owner?.lostPeer(peerID)
  }

  func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
    owner?.fail(error, code: "discovery_failed")
  }

  func advertiser(
    _ advertiser: MCNearbyServiceAdvertiser,
    didReceiveInvitationFromPeer peerID: MCPeerID,
    withContext context: Data?,
    invitationHandler: @escaping (Bool, MCSession?) -> Void
  ) {
    owner?.acceptInvitation(from: peerID, invitationHandler)
  }

  func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
    owner?.fail(error, code: "advertising_failed")
  }

  func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
    owner?.connectionChanged(state, peer: peerID)
  }

  func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
    owner?.receiveDiscoveryToken(data, from: peerID)
  }

  func session(
    _ session: MCSession,
    didReceive stream: InputStream,
    withName streamName: String,
    fromPeer peerID: MCPeerID
  ) {}

  func session(
    _ session: MCSession,
    didStartReceivingResourceWithName resourceName: String,
    fromPeer peerID: MCPeerID,
    with progress: Progress
  ) {}

  func session(
    _ session: MCSession,
    didFinishReceivingResourceWithName resourceName: String,
    fromPeer peerID: MCPeerID,
    at localURL: URL?,
    withError error: Error?
  ) {}
}

private final class ParallaxNearbyInteractionDelegate: NSObject, NISessionDelegate {
  weak var owner: ParallaxModule?

  init(owner: ParallaxModule) {
    self.owner = owner
  }

  func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
    owner?.distanceUpdated(nearbyObjects)
  }

  func session(
    _ session: NISession,
    didUpdateAlgorithmConvergence convergence: NIAlgorithmConvergence
  ) {}

  func sessionWasSuspended(_ session: NISession) {
    owner?.sessionWasSuspended()
  }

  func sessionSuspensionEnded(_ session: NISession) {
    owner?.sessionSuspensionEnded(session)
  }

  func session(_ session: NISession, didInvalidateWith error: Error) {
    owner?.nearbyInteractionInvalidated(error)
  }
}
