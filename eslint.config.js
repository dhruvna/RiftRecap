export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "unused-imports": (await import("eslint-plugin-unused-imports")).default,
    },
    rules: {
      // Auto-remove unused imports with --fix
      "unused-imports/no-unused-imports": "error",

      // Keep unused vars check, but ignore underscore-prefixed args/vars
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // optional: disable base rule to avoid duplicate reporting
      "no-unused-vars": "off",

      // Prevent duplicate keys inside object literals
      "no-dupe-keys": "error",
    },
  },
];