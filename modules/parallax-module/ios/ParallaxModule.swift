import ExpoModulesCore
import MultipeerConnectivity
import NearbyInteraction

public class ParallaxModule: Module {
  private let serviceType = "parallax-uwb"
  private var browser: MCNearbyServiceBrowser?
  private var session: MCSession?
  private var niSession: NISession?
  private var peers: [String: MCPeerID] = [:]
  private var selectedPeer: MCPeerID?

  public func definition() -> ModuleDefinition {
    Name("ParallaxModule")
    Events("peerDiscovered", "connectionChanged", "distanceUpdated", "error")
    AsyncFunction("startDiscovery") { [weak self] in self?.startDiscovery() }
    AsyncFunction("stopDiscovery") { [weak self] in self?.stopDiscovery() }
    AsyncFunction("connect") { [weak self] (peerId: String) in try self?.connect(peerId: peerId) }
    AsyncFunction("disconnect") { [weak self] in self?.disconnect() }
    AsyncFunction("startRanging") { [weak self] in try self?.startRanging() }
    AsyncFunction("stopRanging") { [weak self] in self?.niSession?.invalidate(); self?.niSession = nil }
  }

  private func startDiscovery() { let local = MCPeerID(displayName: UIDevice.current.name); let mc = MCSession(peer: local, securityIdentity: nil, encryptionPreference: .required); mc.delegate = self; session = mc; let next = MCNearbyServiceBrowser(peer: local, serviceType: serviceType); next.delegate = self; browser = next; next.startBrowsingForPeers(); sendEvent("connectionChanged", ["state": "disconnected"]) }
  private func stopDiscovery() { browser?.stopBrowsingForPeers(); browser = nil; session?.disconnect(); session = nil; peers.removeAll() }
  private func connect(peerId: String) throws { guard let peer = peers[peerId], let browser else { throw NSError(domain: "Parallax", code: 1, userInfo: [NSLocalizedDescriptionKey: "Peer is no longer available"]) }; selectedPeer = peer; sendEvent("connectionChanged", ["state": "connecting"]); browser.invitePeer(peer, to: session!, withContext: nil, timeout: 15) }
  private func disconnect() { niSession?.invalidate(); niSession = nil; session?.disconnect(); selectedPeer = nil; sendEvent("connectionChanged", ["state": "disconnected"]) }
  private func startRanging() throws { guard let peer = selectedPeer, let session else { throw NSError(domain: "Parallax", code: 2, userInfo: [NSLocalizedDescriptionKey: "Connect to a peer before ranging"]) }; guard NISession.isSupported else { throw NSError(domain: "Parallax", code: 3, userInfo: [NSLocalizedDescriptionKey: "Nearby Interaction is not supported on this device"]) }; let ni = NISession(); ni.delegate = self; niSession = ni; let token = ni.discoveryToken!.rawValue; try session.send(token, toPeers: [peer], with: .reliable) }
  private func fail(_ error: Error, code: String = "native_error") { sendEvent("error", ["code": code, "message": error.localizedDescription, "recoverable": true]) }
}

extension ParallaxModule: MCNearbyServiceBrowserDelegate { public func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String : String]?) { peers[peerID.displayName] = peerID; sendEvent("peerDiscovered", ["id": peerID.displayName, "name": peerID.displayName]) }; public func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) { peers.removeValue(forKey: peerID.displayName) }; public func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) { fail(error, code: "discovery_failed") } }
extension ParallaxModule: MCSessionDelegate { public func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) { let value = state == .connected ? "connected" : state == .connecting ? "connecting" : "disconnected"; sendEvent("connectionChanged", ["state": value]) }; public func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) { if let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self, from: data) { niSession?.run(NINearbyPeerConfiguration(peerToken: token)) } }; public func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}; public func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}; public func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {} }
extension ParallaxModule: NISessionDelegate { public func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) { guard let object = nearbyObjects.first, let distance = object.distance else { return }; sendEvent("distanceUpdated", ["distanceCm": distance * 100, "timestamp": Date().timeIntervalSince1970 * 1000, "direction": object.direction.map { ["x": $0.x, "y": $0.y, "z": $0.z] } as Any]) }; public func session(_ session: NISession, didUpdateAlgorithmConvergence convergence: NIAlgorithmConvergence) {}; public func sessionWasSuspended(_ session: NISession) { sendEvent("connectionChanged", ["state": "recovering"]) }; public func sessionSuspensionEnded(_ session: NISession) { if let peer = selectedPeer, let token = session.discoveryToken { self.session?.send(token.rawValue, toPeers: [peer], with: .reliable) } }; public func session(_ session: NISession, didInvalidateWith reason: NISessionInvalidationReason) { sendEvent("error", ["code": "ni_invalidated", "message": String(describing: reason), "recoverable": true]) } }
