const $ = (id) => document.getElementById(id);
let pendingResume = null;

init();

async function init() {
  const { apiKey, helperToken, profile, resume, tailorEnabled = true } = await chrome.storage.local.get(['apiKey', 'helperToken', 'profile', 'resume', 'tailorEnabled']);
  $('tailor').checked = tailorEnabled;
  if (apiKey) {
    $('key').value = apiKey;
    $('keyState').textContent = 'key saved';
  }
  if (helperToken) {
    $('token').value = helperToken;
    $('tokenState').textContent = 'token saved';
  }
  if (profile) {
    $('profile').value = JSON.stringify(profile, null, 2);
    $('profileState').textContent = 'profile saved (read-only — edit in the dashboard)';
  }
  if (resume) $('resumeState').textContent = `saved: ${resume.name} (${Math.round(resume.b64.length * 0.75 / 1024)} KB)`;
}

$('resume').addEventListener('change', () => {
  const file = $('resume').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingResume = {
      name: file.name,
      mime: file.type || 'application/pdf',
      b64: String(reader.result).split(',')[1],
    };
    $('resumeState').textContent = `ready: ${file.name}`;
  };
  reader.readAsDataURL(file);
});

$('save').addEventListener('click', async () => {
  $('saved').textContent = '';
  const patch = {};

  const key = $('key').value.trim();
  if (key) patch.apiKey = key;

  const token = $('token').value.trim();
  if (token) patch.helperToken = token;

  if (pendingResume) patch.resume = pendingResume;
  patch.tailorEnabled = $('tailor').checked;

  await chrome.storage.local.set(patch);
  $('saved').textContent = 'saved.';
  $('saved').className = 'ok';
});
