require 'json'
config = JSON.parse(File.read(File.join(__dir__, '..', 'expo-module.config.json')))
Pod::Spec.new do |s|
  s.name = 'ParallaxModule'; s.version = '0.1.0'; s.summary = 'Parallax Nearby Interaction module'; s.homepage = 'https://example.invalid/parallax'; s.license = { type: 'MIT' }; s.author = 'Parallax'; s.platforms = { ios: '16.0' }; s.source = { git: 'https://example.invalid/parallax.git', tag: s.version }; s.source_files = 'ParallaxModule.swift'; s.dependency 'ExpoModulesCore'; s.frameworks = 'MultipeerConnectivity', 'NearbyInteraction'
end
