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
      "no-duplicate-imports": "error",
      "quotes": ["error", "single", { "avoidEscape": true, "allowTemplateLiterals": false }],
      "object-curly-spacing": ["error", "always"],
      "comma-spacing": ["error", { "before": false, "after": true }],
      "space-before-blocks": ["error", "always"],
      "keyword-spacing": ["error", { "before": true, "after": true }],
      "semi": ["error", "always"],

    },
  },
];