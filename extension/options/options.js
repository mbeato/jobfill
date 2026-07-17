const $ = (id) => document.getElementById(id);
let pendingResume = null;

init();

async function init() {
  const { apiKey, profile, resume } = await chrome.storage.local.get(['apiKey', 'profile', 'resume']);
  if (apiKey) {
    $('key').value = apiKey;
    $('keyState').textContent = 'key saved';
  }
  if (profile) {
    $('profile').value = JSON.stringify(profile, null, 2);
    $('profileState').textContent = 'profile saved';
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

  const profileText = $('profile').value.trim();
  if (profileText) {
    try {
      patch.profile = JSON.parse(profileText);
      $('profileState').textContent = 'profile valid';
      $('profileState').className = 'ok';
    } catch (e) {
      $('profileState').textContent = `invalid JSON: ${e.message}`;
      $('profileState').className = 'err';
      return;
    }
  }

  if (pendingResume) patch.resume = pendingResume;

  await chrome.storage.local.set(patch);
  $('saved').textContent = 'saved.';
  $('saved').className = 'ok';
});
