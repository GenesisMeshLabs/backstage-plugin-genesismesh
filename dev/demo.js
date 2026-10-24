const form = document.querySelector('#form');
const days = document.querySelector('#days');
const status = document.querySelector('#status');
const events = document.querySelector('#events');
const base = location.pathname.replace(/\/$/, '');

function renderTask(task) {
  const messages = task.events.map(event => event.body?.message ?? '');
  const denied = messages.some(message => message.includes('Genesis Mesh denied this request.'));
  status.textContent = denied ? 'Denied by Genesis Mesh · The secret was not changed.'
    : task.status === 'completed' ? 'Completed · View the execution evidence status below.'
      : `Task ${task.id} · ${task.status}`;
  const lines = messages.map(message => message.split('\n')[0]);
  for (const event of task.events) {
    for (const output of event.body?.output?.text ?? []) {
      lines.push('', output.title, output.content);
    }
  }
  events.textContent = lines.join('\n');
}

async function run(lifetimeDays) {
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  events.textContent = '';
  status.textContent = 'Submitting request to Backstage…';
  try {
    const response = await fetch(`${base}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lifetimeDays }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const result = await fetch(`${base}/runs/${encodeURIComponent(body.id)}`);
      if (!result.ok) throw new Error('Could not read task status');
      const task = await result.json();
      renderTask(task);
      if (['completed', 'failed', 'cancelled'].includes(task.status)) return;
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    throw new Error('The task is still running. Check the backend log.');
  } catch (error) {
    status.textContent = error.message;
  } finally {
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  run(Number(days.value));
});
document.querySelector('#deny').addEventListener('click', () => {
  days.value = '90';
  run(90);
});
