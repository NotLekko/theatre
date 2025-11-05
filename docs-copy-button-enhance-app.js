/**
 * VuePress client-side enhancement to automatically add copy buttons to code blocks
 * 
 * This file should be added to your VuePress config as an enhanceApp.js file
 * or included in your .vuepress/enhanceApp.js
 */

import CopyCodeButton from './docs-copy-button-component.vue'

export default ({
  Vue, // the version of Vue being used in the VuePress app
  options, // the options for the root Vue instance
  router, // the router instance for the app
  siteData // site metadata
}) => {
  // Register the CopyCodeButton component globally
  Vue.component('CopyCodeButton', CopyCodeButton)

  // Automatically add copy buttons to all code blocks after page navigation
  if (typeof window !== 'undefined') {
    router.afterEach(() => {
      // Wait for DOM to update
      Vue.nextTick(() => {
        addCopyButtonsToCodeBlocks()
      })
    })

    // Also run on initial page load
    Vue.nextTick(() => {
      addCopyButtonsToCodeBlocks()
    })
  }
}

/**
 * Function to automatically add copy buttons to all code blocks
 */
function addCopyButtonsToCodeBlocks() {
  // Find all code blocks
  const codeBlocks = document.querySelectorAll('div[class*="language-"], pre[class*="language-"], pre code')

  codeBlocks.forEach((codeBlock) => {
    // Skip if button already exists
    if (codeBlock.querySelector('.copy-code-button')) {
      return
    }

    // Get the actual code element
    let codeElement = codeBlock
    if (codeBlock.tagName === 'DIV') {
      codeElement = codeBlock.querySelector('code')
    }
    if (!codeElement) {
      codeElement = codeBlock
    }

    // Get the code content
    const codeText = codeElement.textContent || codeElement.innerText

    // Make the container relative positioned if it isn't already
    const container = codeBlock.tagName === 'DIV' ? codeBlock : codeBlock.parentElement
    if (container) {
      const position = window.getComputedStyle(container).position
      if (position === 'static') {
        container.style.position = 'relative'
      }

      // Create button element
      const button = document.createElement('button')
      button.className = 'copy-code-button'
      button.innerHTML = `
        <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span class="copy-text">Copy</span>
      `
      button.setAttribute('aria-label', 'Copy to clipboard')
      button.setAttribute('title', 'Copy to clipboard')

      // Add click handler
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeText)
          button.classList.add('copied')
          button.innerHTML = `
            <svg class="check-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span class="copy-text">Copied!</span>
          `
          button.setAttribute('aria-label', 'Copied!')
          button.setAttribute('title', 'Copied!')
          
          setTimeout(() => {
            button.classList.remove('copied')
            button.innerHTML = `
              <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span class="copy-text">Copy</span>
            `
            button.setAttribute('aria-label', 'Copy to clipboard')
            button.setAttribute('title', 'Copy to clipboard')
          }, 2000)
        } catch (err) {
          console.error('Failed to copy code:', err)
          // Fallback for older browsers
          fallbackCopyTextToClipboard(codeText, button)
        }
      })

      // Append button to container
      container.appendChild(button)
    }
  })
}

/**
 * Fallback copy function for older browsers
 */
function fallbackCopyTextToClipboard(text, button) {
  const textArea = document.createElement('textarea')
  textArea.value = text
  textArea.style.top = '0'
  textArea.style.left = '0'
  textArea.style.position = 'fixed'
  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()
  try {
    const successful = document.execCommand('copy')
    if (successful) {
      button.classList.add('copied')
      button.innerHTML = `
        <svg class="check-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span class="copy-text">Copied!</span>
      `
      setTimeout(() => {
        button.classList.remove('copied')
        button.innerHTML = `
          <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span class="copy-text">Copy</span>
        `
      }, 2000)
    }
  } catch (err) {
    console.error('Fallback: Oops, unable to copy', err)
  }
  document.body.removeChild(textArea)
}

