# Copy to Clipboard Button Implementation

This directory contains the implementation for adding "Copy to Clipboard" buttons to code blocks in the Theatre.js documentation, addressing issue #512.

## Files Created

1. **`docs-copy-button-component.vue`** - Vue component for the copy button (optional, for Vue-based approach)
2. **`docs-copy-button-simple.js`** - Simple JavaScript implementation (recommended)
3. **`docs-copy-button-styles.css`** - Styles for the copy button
4. **`docs-copy-button-integration.md`** - Detailed integration guide
5. **`docs-vuepress-config-example.js`** - Example VuePress configuration

## Quick Start (Simplest Approach)

To integrate this into the theatre-docs repository:

### Step 1: Copy the files

```bash
# In the theatre-docs repository
# Copy the simple JavaScript implementation
cp docs-copy-button-simple.js .vuepress/enhanceApp.js

# Copy the styles
mkdir -p .vuepress/public/styles
cp docs-copy-button-styles.css .vuepress/public/styles/copy-button.css
```

### Step 2: Update VuePress config

Add to your `.vuepress/config.js`:

```javascript
module.exports = {
  head: [
    // ... existing head tags
    ['link', { rel: 'stylesheet', href: '/styles/copy-button.css' }]
  ],
  // ... rest of config
}
```

That's it! The copy buttons will automatically appear on all code blocks.

## Features

✅ **Automatic detection** - Works with all code blocks automatically  
✅ **Modern Clipboard API** - Uses `navigator.clipboard.writeText()`  
✅ **Fallback support** - Works in older browsers with `document.execCommand()`  
✅ **Visual feedback** - Shows "Copied!" message for 2 seconds  
✅ **Dark mode support** - Adapts to light/dark themes  
✅ **Responsive** - Works on mobile devices  
✅ **Accessible** - Includes ARIA labels and keyboard support  

## How It Works

1. The `enhanceApp.js` script runs after each page navigation
2. It finds all code blocks using `div[class*="language-"]` and `pre[class*="language-"]` selectors
3. For each code block, it:
   - Extracts the code text
   - Creates a copy button in the top-right corner
   - Adds a click handler that copies the code to clipboard
   - Shows visual feedback when copied

## Customization

### Change button position

Edit `.vuepress/public/styles/copy-button.css`:

```css
.copy-code-button {
  top: 0.5rem;    /* Adjust top position */
  right: 0.5rem;  /* Adjust right position */
}
```

### Change success color

```css
.copy-code-button.copied {
  background: #10b981;  /* Change to your preferred color */
}
```

### Change button text

Edit `.vuepress/enhanceApp.js` and search for `"Copy"` and `"Copied!"` strings.

## Browser Support

- ✅ Chrome/Edge (latest)
- ✅ Firefox (latest)
- ✅ Safari (latest)
- ✅ Mobile browsers (iOS Safari, Chrome Mobile)
- ✅ Older browsers (with fallback)

## Testing Checklist

After integration, verify:

- [ ] Copy buttons appear on all code blocks
- [ ] Clicking a button copies the code correctly
- [ ] "Copied!" feedback appears after clicking
- [ ] Button resets after 2 seconds
- [ ] Works in light mode
- [ ] Works in dark mode (if supported)
- [ ] Works on mobile devices
- [ ] Works with different code block languages

## Example Code Blocks to Test

Test with these code block types:

1. **Shell commands:**
   ```bash
   npm install --save react three @react-three/fiber
   ```

2. **TypeScript code:**
   ```typescript
   import * as THREE from 'three'
   import { createRoot } from 'react-dom/client'
   ```

3. **JavaScript:**
   ```javascript
   const demoSheet = getProject('Demo Project').sheet('Demo Sheet')
   ```

## Troubleshooting

### Buttons don't appear

- Check that `enhanceApp.js` is in `.vuepress/enhanceApp.js`
- Check browser console for errors
- Verify CSS file is loaded (check Network tab)

### Copy doesn't work

- Check browser console for errors
- Verify you're using HTTPS or localhost (Clipboard API requires secure context)
- Try the fallback method (should work in older browsers)

### Styling issues

- Check that CSS file is loaded
- Verify code blocks have `position: relative` (should be automatic)
- Check for CSS conflicts with existing styles

## Next Steps

1. Integrate into theatre-docs repository
2. Test on staging/preview environment
3. Deploy to production
4. Close issue #512

## Credits

This implementation follows best practices from:
- React documentation
- Vite documentation
- TailwindCSS documentation

All mentioned in the original issue as inspiration.

