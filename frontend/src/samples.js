// Sample material for a one-click demo. The image is generated in the browser so the project
// carries no binary assets and the vision step still has something real to inspect.

const CONTENT = [
  {
    name: 'launch_post.txt',
    text: `Introducing AcmePhone X, the best smartphone ever made.

Its battery lasts 48 hours on a single charge. Charge from 0 to 100% in just 20 minutes.
Starting at $799 for a limited time. Water resistant up to 5 meters.
Available in 40 countries from March 1.

Pick up your Acme X today. Free to try for 30 days.`,
  },
  {
    name: 'social_caption.txt',
    text: 'AcmePhone X: unbeatable speed. #1 in customer satisfaction. Guaranteed to change how you shoot.',
  },
  {
    name: 'preorder_email.eml',
    text: `From: Marketing <marketing@acme.example>
To: Subscribers <list@acme.example>
Date: Mon, 12 Jan 2026 09:00:00 +0000
Subject: Pre-order AcmePhone X today
Content-Type: text/plain; charset="utf-8"

Pre-order AcmePhone X today. The 128GB model is $799.
Free shipping on every order.`,
  },
];

const REFERENCE = [
  {
    name: 'product_facts.txt',
    text: `AcmePhone X approved facts (updated January 2026)

Battery life: up to 36 hours of mixed use.
Fast charging: 0 to 50% in 20 minutes.
Price: $849 for the 128GB model.
Water resistance: IP68, up to 1.5 meters for 30 minutes.
Availability: 25 countries from March 15.
Free shipping applies to orders over $50. Terms apply.`,
  },
  {
    name: 'brand_guidelines.md',
    text: `# Acme brand guidelines

- Never use superlatives such as "best" or "unbeatable" unless an approved source supports them.
- Do not claim "#1" or "guaranteed" without a legal-approved source.
- Always write the product name as AcmePhone X, never "Acme X".
- Write in a friendly, plain tone and avoid hype.
- Every image must have alt text.`,
  },
];

async function makeSampleImage() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 560;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#111a36';
  ctx.fillRect(0, 0, 900, 560);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let x = 0; x < 900; x += 36) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 560); ctx.stroke(); }
  for (let y = 0; y < 560; y += 36) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(900, y); ctx.stroke(); }

  ctx.fillStyle = '#ffc947';
  ctx.fillRect(72, 72, 54, 54);
  ctx.fillStyle = '#111111';
  ctx.font = '700 26px sans-serif';
  ctx.fillText('ACME', 82, 108);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 58px sans-serif';
  ctx.fillText('AcmePhone X', 72, 220);
  ctx.fillStyle = '#c8f26a';
  ctx.font = '700 40px sans-serif';
  ctx.fillText('48h battery', 72, 286);
  ctx.fillStyle = '#8ec3f0';
  ctx.font = '500 28px sans-serif';
  ctx.fillText('from $799', 72, 336);
  ctx.fillStyle = '#d8d3c8';
  ctx.font = '400 20px sans-serif';
  ctx.fillText('Limited time. Water resistant up to 5 meters.', 72, 382);

  ctx.save();
  ctx.translate(610, 120);
  ctx.rotate(-0.12);
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, 210, 360);
  ctx.strokeStyle = '#ff9f43';
  ctx.lineWidth = 8;
  ctx.strokeRect(0, 0, 210, 360);
  ctx.fillStyle = '#1f2b52';
  ctx.fillRect(14, 20, 182, 320);
  ctx.fillStyle = '#ff5a3c';
  ctx.beginPath();
  ctx.arc(105, 180, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 16px sans-serif';
  ctx.fillText('ACME', 82, 186);
  ctx.restore();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? new File([blob], 'launch_hero.png', { type: 'image/png' }) : null;
}

export async function loadSamples() {
  const mk = (list) => list.map((f) => new File([f.text], f.name, { type: f.name.endsWith('.eml') ? 'message/rfc822' : 'text/plain' }));
  const image = await makeSampleImage();
  const content = [...mk(CONTENT), ...(image ? [image] : [])];
  return { content, reference: mk(REFERENCE) };
}

export { CONTENT as SAMPLE_CONTENT, REFERENCE as SAMPLE_REFERENCES };
