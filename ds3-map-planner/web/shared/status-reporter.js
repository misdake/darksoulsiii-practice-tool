export function createStatusReporter(element, options = {}) {
  const readyText = options.readyText || "ready";
  const successColor = options.successColor || "#87f5b1";
  const errorColor = options.errorColor || "#fb7185";
  let resetTimer = null;

  return (message, isError = false, clearAfterMs = 0) => {
    if (resetTimer) {
      clearTimeout(resetTimer);
    }

    resetTimer = null;
    element.style.color = isError ? errorColor : successColor;
    element.textContent = message;
    if (isError || clearAfterMs <= 0) {
      return;
    }

    resetTimer = setTimeout(() => {
      element.style.color = successColor;
      element.textContent = readyText;
      resetTimer = null;
    }, clearAfterMs);
  };
}
