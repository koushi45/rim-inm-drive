const form = document.querySelector("#setup");
const serverUrl = document.querySelector("#serverUrl");
const localPath = document.querySelector("#localPath");
const accountName = document.querySelector("#accountName");
const password = document.querySelector("#password");
const status = document.querySelector("#status");
const submit = document.querySelector("#submit");

window.driveClient.getConfig().then((config) => {
  serverUrl.value = config.serverUrl;
  localPath.value = config.localPath;
  accountName.value = config.accountName || "";
});

document.querySelector("#chooseFolder").addEventListener("click", async () => {
  const selected = await window.driveClient.chooseFolder();
  if (selected) localPath.value = selected;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  status.textContent = "接続して同期を開始しています...";
  status.dataset.type = "info";
  try {
    await window.driveClient.setup({
      serverUrl: serverUrl.value,
      localPath: localPath.value,
      accountName: accountName.value,
      password: password.value,
    });
  } catch (error) {
    status.textContent = error.message;
    status.dataset.type = "error";
    submit.disabled = false;
  }
});
