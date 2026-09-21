export const tableauConfig = {
  platform: 'tableau',
  label: 'Tableau',
  accent: '#2770ef',
  subject: (c) => c.worksheet,
  contextRows: [
    ['Dashboard', (c) => (c.isDashboard ? c.dashboard : c.dashboard ? c.dashboard + ' (sheet view)' : null)],
    ['Workbook', 'workbook'],
    ['Worksheet', 'worksheet'],
    ['Sheet title', 'sheetTitle'],
    ['Zone id', 'zoneId'],
    ['Site', 'site'],
    ['VizQL session', 'sessionId'],
    ['Title element', 'titleElementId'],
  ],
  dataKinds: ['summary', 'underlying'],
  underlyingCap: 10000,
};
