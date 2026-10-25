const { withInfoPlist } = require('@expo/config-plugins');

module.exports = function withParallaxIos(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.NSLocalNetworkUsageDescription =
      'Parallax uses the local network to discover nearby phones and receive tabletop positions from your MacBook camera.';
    config.modResults.NSAppTransportSecurity = {
      ...config.modResults.NSAppTransportSecurity,
      NSAllowsLocalNetworking: true,
    };
    config.modResults.NSNearbyInteractionUsageDescription =
      'Parallax uses Nearby Interaction to measure the distance between paired phones.';
    config.modResults.NSMotionUsageDescription =
      'Parallax uses motion sensors to align the phones and show their relative orientations.';
    config.modResults.NSBonjourServices = ['_parallax-uwb._tcp'];
    return config;
  });
};
