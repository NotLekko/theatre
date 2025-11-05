<template>
  <button
    class="copy-code-button"
    :class="{ 'copied': isCopied }"
    @click="copyToClipboard"
    :aria-label="isCopied ? 'Copied!' : 'Copy to clipboard'"
    :title="isCopied ? 'Copied!' : 'Copy to clipboard'"
  >
    <svg
      v-if="!isCopied"
      class="copy-icon"
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <svg
      v-else
      class="check-icon"
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
    <span class="copy-text">{{ isCopied ? 'Copied!' : 'Copy' }}</span>
  </button>
</template>

<script>
export default {
  name: 'CopyCodeButton',
  props: {
    code: {
      type: String,
      required: true
    }
  },
  data() {
    return {
      isCopied: false
    }
  },
  methods: {
    async copyToClipboard() {
      try {
        await navigator.clipboard.writeText(this.code)
        this.isCopied = true
        setTimeout(() => {
          this.isCopied = false
        }, 2000)
      } catch (err) {
        console.error('Failed to copy code:', err)
        // Fallback for older browsers
        this.fallbackCopyTextToClipboard(this.code)
      }
    },
    fallbackCopyTextToClipboard(text) {
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
          this.isCopied = true
          setTimeout(() => {
            this.isCopied = false
          }, 2000)
        }
      } catch (err) {
        console.error('Fallback: Oops, unable to copy', err)
      }
      document.body.removeChild(textArea)
    }
  }
}
</script>

<style scoped>
.copy-code-button {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.75rem;
  background: rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 0.375rem;
  font-size: 0.875rem;
  color: #666;
  cursor: pointer;
  transition: all 0.2s ease;
  z-index: 10;
}

.copy-code-button:hover {
  background: rgba(0, 0, 0, 0.1);
  color: #333;
}

.copy-code-button.copied {
  background: #10b981;
  border-color: #10b981;
  color: white;
}

.copy-code-button.copied:hover {
  background: #059669;
}

.copy-icon,
.check-icon {
  flex-shrink: 0;
}

.copy-text {
  font-size: 0.875rem;
  font-weight: 500;
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  .copy-code-button {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.2);
    color: #ccc;
  }

  .copy-code-button:hover {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
  }
}
</style>

