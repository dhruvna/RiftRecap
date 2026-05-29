/** @type {import('knip').KnipConfig} */
export default {
  // Slash command modules and smoke tests are loaded outside Knip's default
  // package-script entry detection, so list them explicitly.
  entry: [
    'src/commands/*.js',
    'src/tests/*.js',
  ],

  // Scan source files only.
  project: ['src/**/*.js'],
};
