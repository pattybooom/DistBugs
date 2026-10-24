const { withInfoPlist } = require('@expo/config-plugins');

module.exports = function withParallaxIos(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.NSLocalNetworkUsageDescription =
      'Parallax uses the local network to discover nearby phones.';
    config.modResults.NSNearbyInteractionUsageDescription =
      'Parallax uses Nearby Interaction to measure the distance between paired phones.';
    config.modResults.NSBonjourServices = ['_parallax-uwb._tcp'];
    return config;
  });
};
