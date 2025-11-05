/**
 * Simple standalone script to add copy buttons to code blocks
 * 
 * This can be added directly to your VuePress config.js or as a client-side script
 * Usage: Copy this entire file to .vuepress/enhanceApp.js or add to your existing enhanceApp.js
 */

export default ({ router }) => {
  if (typeof window === 'undefined') return

  // Add copy buttons after each route navigation
  router.afterEach(() => {
    // Use setTimeout to ensure DOM is ready
    setTimeout(() => {
      addCopyButtonsToCodeBlocks()
    }, 100)
  })

  // Add copy buttons on initial page load
  setTimeout(() => {
    addCopyButtonsToCodeBlocks()
  }, 1000)
}

/**
 * Automatically adds copy buttons to all code blocks on the page
 */
function addCopyButtonsToCodeBlocks() {
  // Find all code blocks - VuePress uses div[class*="language-"] for highlighted code
  const codeBlocks = document.querySelectorAll('div[class*="language-"], pre[class*="language-"]')

  codeBlocks.forEach((codeBlock) => {
    // Skip if button already exists
    if (codeBlock.querySelector('.copy-code-button')) {
      return
    }

    // Get the actual code element
    let codeElement = codeBlock.querySelector('code')
    if (!codeElement) {
      codeElement = codeBlock
    }

    // Get the code content, preserving formatting
    const codeText = codeElement.textContent || codeElement.innerText

    if (!codeText.trim()) {
      return
    }

    // Make the container relative positioned if it isn't already
    const container = codeBlock.tagName === 'DIV' ? codeBlock : codeBlock.parentElement
    if (!container) {
      return
    }

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
    button.setAttribute('type', 'button')

    // Add click handler
    button.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      
      try {
        // Use modern Clipboard API
        await navigator.clipboard.writeText(codeText)
        showCopiedFeedback(button)
      } catch (err) {
        // Fallback for older browsers or when clipboard API fails
        console.warn('Clipboard API failed, using fallback:', err)
        fallbackCopyTextToClipboard(codeText, button)
      }
    })

    // Append button to container
    container.appendChild(button)
  })
}

/**
 * Shows "Copied!" feedback on the button
 */
function showCopiedFeedback(button) {
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
}

/**
 * Fallback copy function for older browsers that don't support Clipboard API
 */
function fallbackCopyTextToClipboard(text, button) {
  const textArea = document.createElement('textarea')
  textArea.value = text
  textArea.style.top = '0'
  textArea.style.left = '0'
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'
  textArea.style.pointerEvents = 'none'
  
  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()
  
  try {
    const successful = document.execCommand('copy')
    if (successful) {
      showCopiedFeedback(button)
    } else {
      console.error('Fallback copy command failed')
    }
  } catch (err) {
    console.error('Fallback: Unable to copy', err)
  }
  
  document.body.removeChild(textArea)
}

