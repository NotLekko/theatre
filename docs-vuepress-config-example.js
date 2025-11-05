/**
 * Example VuePress config.js showing how to integrate the copy button feature
 * 
 * This is an example - add the relevant parts to your existing .vuepress/config.js
 */

const { description } = require('../../package')

module.exports = {
  /**
   * Base URL for the site
   */
  base: '/docs/', // or '/' if at root

  /**
   * Site title
   */
  title: 'Theatre.js Documentation',

  /**
   * Site description
   */
  description: description,

  /**
   * Head tags
   */
  head: [
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
    ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black' }],
    // Add the copy button styles
    ['link', { rel: 'stylesheet', href: '/styles/copy-button.css' }]
  ],

  /**
   * Theme configuration
   */
  themeConfig: {
    // ... your existing theme config
  },

  /**
   * Client-side enhancements
   * This is where you add the copy button functionality
   */
  enhanceAppFiles: [
    // Add the copy button enhancement script
    // Path: .vuepress/enhanceApp.js
    // Or you can inline it here by copying the content from docs-copy-button-simple.js
  ],

  /**
   * Alternative: If you're using enhanceApp.js separately, make sure it's in .vuepress/enhanceApp.js
   * and VuePress will automatically pick it up
   */
}

/**
 * SIMPLER APPROACH:
 * 
 * Instead of modifying config.js, you can:
 * 
 * 1. Copy docs-copy-button-simple.js to .vuepress/enhanceApp.js
 * 2. Copy docs-copy-button-styles.css to .vuepress/public/styles/copy-button.css
 * 3. Add this to your config.js head array:
 *    ['link', { rel: 'stylesheet', href: '/styles/copy-button.css' }]
 * 
 * That's it! VuePress will automatically load enhanceApp.js
 */

