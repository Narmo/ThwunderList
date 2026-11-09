const checkbox = document.getElementById("showAvatars");
const previewLines = document.getElementById("previewLines");
const layoutSettings = document.getElementById("layoutSettings");
const status = document.getElementById("status");
let savedPreviewLines;

async function loadSettings() {
  try {
    const [showAvatars, lines] = await Promise.all([
      browser.mailList.getShowAvatars(),
      browser.mailList.getPreviewLines(),
    ]);
    checkbox.checked = showAvatars;
    previewLines.value = lines;
    savedPreviewLines = lines;
    checkbox.disabled = false;
    layoutSettings.disabled = false;
  } catch (error) {
    status.textContent = "Could not load the settings. Try reopening this page.";
    console.error(error);
  }
}

checkbox.addEventListener("change", async () => {
  checkbox.disabled = true;
  try {
    await browser.mailList.setShowAvatars(checkbox.checked);
    status.textContent = "Saved.";
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    status.textContent = "Could not save the setting. Please try again.";
    console.error(error);
  } finally {
    checkbox.disabled = false;
  }
});

async function savePreviewLines() {
  if (!previewLines.reportValidity()) {
    return;
  }
  const lines = previewLines.valueAsNumber;
  layoutSettings.disabled = true;
  try {
    await browser.mailList.setPreviewLines(lines);
    savedPreviewLines = lines;
    status.textContent = "Saved.";
  } catch (error) {
    previewLines.value = savedPreviewLines;
    status.textContent = "Could not save the setting. Please try again.";
    console.error(error);
  } finally {
    layoutSettings.disabled = false;
  }
}

previewLines.addEventListener("change", savePreviewLines);

browser.mailList.onShowAvatarsChanged.addListener(showAvatars => {
  checkbox.checked = showAvatars;
  status.textContent = "";
});

loadSettings();
