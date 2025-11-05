# Copy to Clipboard Button Integration Guide

This guide explains how to integrate the copy-to-clipboard button feature into the Theatre.js documentation (theatre-docs repository).

## Overview

The copy button feature consists of three main files:
1. `docs-copy-button-component.vue` - Vue component for the copy button
2. `docs-copy-button-enhance-app.js` - Client-side enhancement script
3. `docs-copy-button-styles.css` - Styles for the copy button

## Integration Steps

### Option 1: Using Vue Component (Recommended for VuePress)

1. **Copy the component file:**
   - Copy `docs-copy-button-component.vue` to `.vuepress/components/CopyCodeButton.vue` in your theatre-docs repository

2. **Add the enhancement script:**
   - Copy `docs-copy-button-enhance-app.js` to `.vuepress/enhanceApp.js` (or merge with existing enhanceApp.js)
   - Update the import path if needed:
     ```javascript
     import CopyCodeButton from './components/CopyCodeButton.vue'
     ```

3. **Add styles:**
   - Copy the CSS from `docs-copy-button-styles.css` to your global styles file (e.g., `.vuepress/styles/index.styl` or `.vuepress/styles/index.css`)
   - Or add it to your `config.js`:
     ```javascript
     module.exports = {
       // ... other config
       head: [
         ['link', { rel: 'stylesheet', href: '/styles/copy-button.css' }]
       ]
     }
     ```

### Option 2: Pure JavaScript Implementation (Simpler)

If you prefer a simpler approach without Vue components:

1. **Add the styles:**
   - Copy `docs-copy-button-styles.css` to your styles directory and include it in your VuePress config

2. **Add the client-side script:**
   - Create `.vuepress/enhanceApp.js` (or update existing):
     ```javascript
     export default ({ router }) => {
       if (typeof window !== 'undefined') {
         router.afterEach(() => {
           setTimeout(() => {
             addCopyButtonsToCodeBlocks()
           }, 100)
         })
         
         // Run on initial load
         setTimeout(() => {
           addCopyButtonsToCodeBlocks()
         }, 1000)
       }
     }
     
     function addCopyButtonsToCodeBlocks() {
       const codeBlocks = document.querySelectorAll('div[class*="language-"], pre[class*="language-"]')
       
       codeBlocks.forEach((codeBlock) => {
         if (codeBlock.querySelector('.copy-code-button')) return
         
         const codeElement = codeBlock.querySelector('code') || codeBlock
         const codeText = codeElement.textContent || codeElement.innerText
         
         const container = codeBlock.tagName === 'DIV' ? codeBlock : codeBlock.parentElement
         if (!container) return
         
         const position = window.getComputedStyle(container).position
         if (position === 'static') {
           container.style.position = 'relative'
         }
         
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
           } catch (err) {
             console.error('Failed to copy:', err)
           }
         })
         
         container.appendChild(button)
       })
     }
     ```

## Testing

After integration, test the following:

1. **Code blocks display copy buttons** in the top-right corner
2. **Clicking the button** copies the code to clipboard
3. **Button shows "Copied!" feedback** for 2 seconds after copying
4. **Works in both light and dark modes** (if your docs support dark mode)
5. **Works on mobile devices** (button is responsive)

## Customization

### Changing button position

Edit the CSS:
```css
.copy-code-button {
  top: 0.5rem;    /* Adjust top position */
  right: 0.5rem;  /* Adjust right position */
}
```

### Changing colors

Edit the CSS:
```css
.copy-code-button.copied {
  background: #10b981;  /* Success color */
}
```

### Changing button text

Edit the JavaScript where it says `Copy` and `Copied!`

## Browser Compatibility

- Modern browsers (Chrome, Firefox, Safari, Edge) - Full support
- Older browsers - Falls back to `document.execCommand('copy')`
- No clipboard API support - Graceful degradation

## Notes

- The button automatically appears on all code blocks
- It works with VuePress's syntax highlighting
- The implementation is lightweight and doesn't affect page load performance
- The button is positioned absolutely in the top-right corner of code blocks

