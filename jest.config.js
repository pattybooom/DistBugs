module.exports = { testEnvironment: 'node', testMatch: ['**/tests/**/*.test.ts'], transform: { '^.+\\.(ts|tsx)$': ['babel-jest', { presets: ['@babel/preset-env', '@babel/preset-typescript'] }] } };
