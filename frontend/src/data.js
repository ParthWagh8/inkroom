// The whole workflow lives in the browser. These are the only constants the UI needs to know about.

export const DEFAULT_SETTINGS = {
  mode: null, // resolved from the server; demo | live
  ready: false,
  models: {},
};

export const NODE_SPECS = [
  {
    id: 'input', n: '01', role: 'Start here', title: 'Add your content', kind: 'input', engine: 'person',
    checks: [
      { id: 'content', label: 'Content added' },
      { id: 'refs', label: 'Approved facts added' },
      { id: 'sent', label: 'Review started' },
    ],
  },
  {
    id: 'extract_source', n: '02', role: 'AI reads your draft', title: 'Find the claims', kind: 'agent', engine: 'openrouter',
    checks: [
      { id: 'parse', label: 'Files read' },
      { id: 'model', label: 'Claims found' },
      { id: 'save', label: 'Notes saved' },
    ],
  },
  {
    id: 'check_source', n: '03', role: 'Your check', title: 'Check the claims', kind: 'human', engine: 'person',
    checks: [
      { id: 'shown', label: 'Claims shown to you' },
      { id: 'edits', label: 'Your edits saved' },
      { id: 'confirmed', label: 'Claims confirmed' },
    ],
  },
  {
    id: 'extract_reference', n: '04', role: 'AI reads your sources', title: 'Find approved facts', kind: 'agent', engine: 'openrouter',
    checks: [
      { id: 'parse', label: 'Guidelines read' },
      { id: 'model', label: 'Approved facts found' },
      { id: 'save', label: 'Notes saved' },
    ],
  },
  {
    id: 'check_reference', n: '05', role: 'Your check', title: 'Check the facts', kind: 'human', engine: 'person',
    checks: [
      { id: 'shown', label: 'Facts shown to you' },
      { id: 'edits', label: 'Your edits saved' },
      { id: 'confirmed', label: 'Facts confirmed' },
    ],
  },
  {
    id: 'analyze', n: '06', role: 'AI review', title: 'Spot risky wording', kind: 'agent', engine: 'groq',
    checks: [
      { id: 'pairs', label: 'Claims matched to facts' },
      { id: 'judge', label: 'Risks checked' },
      { id: 'draft', label: 'Safer wording suggested' },
      { id: 'guard', label: 'Numbers double-checked' },
      { id: 'save', label: 'Review saved' },
    ],
  },
  {
    id: 'human_direction', n: '07', role: 'Your decision', title: 'Choose the changes', kind: 'human', engine: 'person',
    checks: [
      { id: 'shown', label: 'Suggestions shown to you' },
      { id: 'decided', label: 'Every suggestion decided' },
      { id: 'save', label: 'Your choices saved' },
    ],
  },
  {
    id: 'synthesize', n: '08', role: 'AI writes the draft', title: 'Write the final version', kind: 'agent', engine: 'mixed',
    checks: [
      { id: 'text', label: 'New text written' },
      { id: 'image', label: 'Image advice written' },
      { id: 'recheck', label: 'New text checked' },
      { id: 'save', label: 'Final draft saved' },
    ],
  },
  {
    id: 'final_approval', n: '09', role: 'Your approval', title: 'Review and approve', kind: 'human', engine: 'person',
    checks: [
      { id: 'shown', label: 'Draft shown to you' },
      { id: 'approved', label: 'You approved it' },
      { id: 'save', label: 'Approval saved' },
    ],
  },
  {
    id: 'output', n: '10', role: 'Your results', title: 'Finished text & images', kind: 'output', engine: 'local',
    checks: [
      { id: 'files', label: 'Final text ready' },
      { id: 'summary', label: 'Summary ready' },
      { id: 'disclosure', label: 'AI-use note added' },
    ],
  },
];

export const STEPS = [
  'extract_source',
  'check_source',
  'extract_reference',
  'check_reference',
  'analyze',
  'human_direction',
  'synthesize',
  'final_approval',
  'output',
];

export const HUMAN_STAGE = {
  check_source: 'source',
  check_reference: 'reference',
  human_direction: 'direction',
  final_approval: 'approval',
};

export const STAGE_NODE = {
  source: 'check_source',
  reference: 'check_reference',
  direction: 'human_direction',
  approval: 'final_approval',
};

export const OPEN_LABEL = {
  check_source: 'REVIEW CLAIMS →',
  check_reference: 'REVIEW FACTS →',
  human_direction: 'CHOOSE CHANGES →',
  final_approval: 'REVIEW & APPROVE →',
};

export const FILE_ORDER = [
  'source.json',
  'reference.json',
  'validate.json',
  'suggest.json',
  'human_input.json',
  'final.json',
  'decisions.json',
  'run.json',
];

export const CONTENT_EXT = ['.txt', '.md', '.csv', '.json', '.html', '.htm', '.eml', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const REFERENCE_EXT = ['.txt', '.md', '.csv', '.json', '.html', '.htm', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif'];

export const MAX_FILE_MB = 12;
export const MAX_FILES_PER_SIDE = 10;
export const MAX_IMAGES_PER_SIDE = 6;
export const MAX_TOTAL_CHARS = 150_000;
export const MAX_STATEMENTS = 200;
export const MAX_LINE_CHARS = 2000;

export const blankNodes = () => Object.fromEntries(
  NODE_SPECS.map((s) => [s.id, {
    status: 'idle',
    note: null,
    checks: s.checks.map((c) => ({ id: c.id, done: false, detail: null })),
  }]),
);
