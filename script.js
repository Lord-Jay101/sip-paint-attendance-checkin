(function () {
  const form = document.getElementById('checkInForm');
  const nameInput = document.getElementById('name');
  const checkInBtn = document.getElementById('checkInBtn');
  const statusEl = document.getElementById('status');
  const formPanel = document.getElementById('formPanel');
  const outcomeNotFound = document.getElementById('outcomeNotFound');
  const tryAgainBtn = document.getElementById('tryAgainBtn');
  const suggestionsEl = document.getElementById('suggestions');

  if (!form || !nameInput) return;

  let submitting = false;
  let debounceTimer;
  let currentSuggestions = [];
  let activeIndex = -1;

  fetch('/api/event')
    .then((r) => r.json())
    .then((data) => {
      if (data.name) document.title = data.name + ' | Check-In';
    })
    .catch(() => {});

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function hideSuggestions() {
    if (!suggestionsEl) return;
    suggestionsEl.classList.remove('visible');
    suggestionsEl.innerHTML = '';
    currentSuggestions = [];
    activeIndex = -1;
    nameInput.setAttribute('aria-expanded', 'false');
  }

  function highlightActive() {
    if (!suggestionsEl) return;
    suggestionsEl.querySelectorAll('.suggestion').forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
    });
  }

  function selectSuggestion(name) {
    nameInput.value = name;
    hideSuggestions();
    nameInput.focus();
  }

  function showSuggestions(list) {
    currentSuggestions = list || [];
    activeIndex = -1;
    if (!suggestionsEl) return;
    if (!currentSuggestions.length) {
      hideSuggestions();
      return;
    }
    suggestionsEl.innerHTML = currentSuggestions
      .map(
        (g, i) =>
          `<div class="suggestion" data-index="${i}" role="option">${escapeHtml(g.name)}</div>`
      )
      .join('');
    suggestionsEl.classList.add('visible');
    nameInput.setAttribute('aria-expanded', 'true');

    suggestionsEl.querySelectorAll('.suggestion').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = parseInt(el.dataset.index, 10);
        if (currentSuggestions[idx]) selectSuggestion(currentSuggestions[idx].name);
      });
    });
  }

  async function fetchSuggestions(q) {
    if (q.trim().length < 4) {
      hideSuggestions();
      return;
    }
    try {
      const res = await fetch('/api/check-in/suggest?q=' + encodeURIComponent(q.trim()));
      const data = await res.json();
      showSuggestions(data.suggestions || []);
    } catch {
      hideSuggestions();
    }
  }

  nameInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    hideStatus();
    const q = nameInput.value;
    if (q.trim().length < 4) {
      hideSuggestions();
      return;
    }
    debounceTimer = setTimeout(() => fetchSuggestions(q), 180);
  });

  nameInput.addEventListener('keydown', (e) => {
    if (!currentSuggestions.length) {
      if (e.key === 'Escape') hideSuggestions();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % currentSuggestions.length;
      highlightActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = activeIndex <= 0 ? currentSuggestions.length - 1 : activeIndex - 1;
      highlightActive();
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      selectSuggestion(currentSuggestions[activeIndex].name);
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  nameInput.addEventListener('blur', () => {
    setTimeout(hideSuggestions, 150);
  });

  function hideStatus() {
    statusEl.className = 'status';
    statusEl.textContent = '';
  }

  function showStatus(type, message) {
    statusEl.className = 'status visible ' + type;
    statusEl.textContent = message;
  }

  function showForm() {
    if (outcomeNotFound) outcomeNotFound.classList.remove('visible');
    formPanel.classList.remove('hidden');
    hideStatus();
    checkInBtn.disabled = false;
    submitting = false;
    nameInput.focus();
  }

  function showNotFound() {
    formPanel.classList.add('hidden');
    hideStatus();
    if (outcomeNotFound) outcomeNotFound.classList.add('visible');
  }

  tryAgainBtn?.addEventListener('click', () => {
    showForm();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;

    const name = (nameInput.value || '').trim();
    hideStatus();
    hideSuggestions();

    if (!name) {
      showStatus('error', 'Please enter your name.');
      nameInput.focus();
      return;
    }

    submitting = true;
    checkInBtn.disabled = true;
    showStatus('loading', 'Checking your booking…');

    try {
      const res = await fetch('/api/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });

      let data;
      try {
        data = await res.json();
      } catch {
        showStatus('error', 'Something went wrong. Please try again.');
        submitting = false;
        checkInBtn.disabled = false;
        return;
      }

      if (data.status === 'found' || data.status === 'already_checked_in') {
        const params = new URLSearchParams({
          id: String(data.id || ''),
          name: data.name || name
        });
        window.location.href = 'result.html?' + params.toString();
        return;
      }

      if (data.status === 'not_found') {
        showNotFound();
        return;
      }

      showStatus('error', data.error || 'Unable to check in. Please try again.');
      submitting = false;
      checkInBtn.disabled = false;
    } catch {
      showStatus('error', 'Unable to reach the server. Please try again.');
      submitting = false;
      checkInBtn.disabled = false;
    }
  });

  nameInput.focus();
})();
