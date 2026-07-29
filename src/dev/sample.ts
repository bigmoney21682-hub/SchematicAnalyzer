/**
 * Synthetic sample schematic — two sheets.
 *
 * Sheet 1 is a Japanese-style power supply and MCU section: mains input, bridge
 * rectifier, 3-terminal regulator, crystal, reset RC, and an I2C header. Sheet 2
 * is the audio output stage that section drives, and deliberately shares the
 * +5V and GND rails, the SDA/SCL pair and the CN1 connector with sheet 1.
 *
 * That overlap is the point: it exercises cross-sheet linking end to end, so
 * the app can be tried on a real multi-sheet document without one to hand, and
 * a regression in linking is obvious -- we know exactly which four links should
 * come back.
 */

const W = 1400;
const H = 900;

/** Drawing helpers bound to one canvas context. */
function pen(g: CanvasRenderingContext2D) {
  const wire = (x0: number, y0: number, x1: number, y1: number, w = 2) => {
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };

  const dot = (x: number, y: number) => {
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
  };

  const boxPart = (x: number, y: number, w: number, h: number, ref: string, val: string) => {
    g.lineWidth = 2;
    g.strokeRect(x, y, w, h);
    g.font = '600 15px sans-serif';
    g.fillText(ref, x, y - 7);
    g.font = '14px sans-serif';
    g.fillText(val, x, y + h + 17);
  };

  const label = (x: number, y: number, text: string, size = 16, weight = '600') => {
    g.font = `${weight} ${size}px "Hiragino Sans", "Noto Sans JP", sans-serif`;
    g.fillText(text, x, y);
  };

  return { wire, dot, boxPart, label };
}

function newSheet(): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fdfdfb';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#1a1a1a';
  g.fillStyle = '#1a1a1a';
  g.lineCap = 'butt';
  g.lineWidth = 2;
  g.strokeRect(20, 20, W - 40, H - 40);
  return { canvas, g };
}

function toFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(new File([b], name, { type: 'image/png' })) : reject(new Error('Could not build the sample image'))),
      'image/png',
    ),
  );
}

/** Both sheets of the sample, in order. */
export async function buildSampleSchematic(): Promise<File[]> {
  return [await buildPowerSheet(), await buildAudioSheet()];
}

// ---------------------------------------------------------------------------
// Sheet 1 — power supply and control
// ---------------------------------------------------------------------------

function buildPowerSheet(): Promise<File> {
  const { canvas, g } = newSheet();
  const { wire, dot, boxPart, label } = pen(g);

  label(40, 55, '電源回路図', 22);
  label(40, 80, 'POWER SUPPLY / CONTROL  (1/2)', 14, '400');

  const RAIL_5V = 200;
  const RAIL_GND = 780;

  wire(120, RAIL_5V, 1300, RAIL_5V, 4);
  label(120, RAIL_5V - 12, '+5V', 17);

  wire(120, RAIL_GND, 1300, RAIL_GND, 4);
  label(120, RAIL_GND + 24, 'GND', 17);
  label(180, RAIL_GND + 24, '接地', 16);

  // --- AC input and rectifier ---------------------------------------------
  label(60, 150, '交流入力', 15);
  wire(120, 300, 120, RAIL_GND, 2);
  wire(120, 300, 260, 300, 2);
  boxPart(260, 275, 90, 50, 'D1', '1N4007');
  wire(350, 300, 470, 300, 2);

  boxPart(470, 275, 70, 50, 'C1', '1000u');
  wire(540, 300, 620, 300, 2);
  wire(505, 325, 505, RAIL_GND, 2);
  dot(505, RAIL_GND);
  label(455, 250, '平滑', 15);

  // --- Regulator ------------------------------------------------------------
  boxPart(620, 265, 120, 70, 'IC1', '7805');
  label(600, 240, '三端子レギュレータ', 15);
  wire(740, 300, 860, 300, 3);
  wire(860, 300, 860, RAIL_5V, 3);
  dot(860, RAIL_5V);
  wire(680, 335, 680, RAIL_GND, 2);
  dot(680, RAIL_GND);

  boxPart(790, 375, 60, 45, 'C2', '100n');
  wire(820, 375, 820, 300, 2);
  dot(820, 300);
  wire(820, 420, 820, RAIL_GND, 2);
  dot(820, RAIL_GND);

  // --- MCU ------------------------------------------------------------------
  g.lineWidth = 2;
  g.strokeRect(560, 470, 220, 200);
  g.font = '600 16px sans-serif';
  g.fillText('IC2', 560, 462);
  g.font = '14px sans-serif';
  g.fillText('UPD78F', 600, 580);

  wire(600, 470, 600, RAIL_5V, 2);
  dot(600, RAIL_5V);
  wire(660, 670, 660, RAIL_GND, 2);
  dot(660, RAIL_GND);

  // --- Crystal --------------------------------------------------------------
  boxPart(380, 500, 70, 45, 'X1', '8MHz');
  label(370, 480, '水晶発振子', 14);
  wire(450, 512, 560, 512, 2);
  wire(380, 512, 330, 512, 2);
  wire(330, 512, 330, 560, 2);
  wire(330, 560, 560, 560, 2);
  label(465, 505, 'XTAL', 13);

  boxPart(300, 610, 55, 40, 'C3', '22p');
  wire(327, 610, 327, 560, 2);
  dot(327, 560);
  wire(327, 650, 327, RAIL_GND, 2);
  dot(327, RAIL_GND);

  // --- Reset ----------------------------------------------------------------
  boxPart(880, 480, 60, 45, 'R1', '10k');
  label(870, 465, 'リセット', 14);
  wire(910, 480, 910, RAIL_5V, 2);
  dot(910, RAIL_5V);
  wire(910, 525, 910, 600, 2);
  wire(780, 600, 910, 600, 2);
  label(795, 592, 'RST', 13);
  dot(910, 600);

  boxPart(880, 640, 60, 45, 'C4', '100n');
  wire(910, 640, 910, 600, 2);
  wire(910, 685, 910, RAIL_GND, 2);
  dot(910, RAIL_GND);

  // --- I2C header — continues on sheet 2 -------------------------------------
  g.lineWidth = 2;
  g.strokeRect(1120, 480, 90, 120);
  g.font = '600 16px sans-serif';
  g.fillText('CN1', 1120, 472);
  label(1100, 630, '通信コネクタ', 14);
  label(1090, 660, '→ 2/2', 13, '400');

  wire(780, 520, 1120, 520, 2);
  label(950, 512, 'SDA', 13);
  wire(780, 560, 1120, 560, 2);
  label(950, 552, 'SCL', 13);

  boxPart(1000, 300, 50, 40, 'R2', '4.7k');
  wire(1025, 300, 1025, RAIL_5V, 2);
  dot(1025, RAIL_5V);
  wire(1025, 340, 1025, 520, 2);
  dot(1025, 520);

  boxPart(1070, 300, 50, 40, 'R3', '4.7k');
  wire(1095, 300, 1095, RAIL_5V, 2);
  dot(1095, RAIL_5V);
  wire(1095, 340, 1095, 560, 2);
  dot(1095, 560);

  // --- Protection -----------------------------------------------------------
  boxPart(160, 380, 60, 45, 'F1', '1A');
  label(150, 365, 'ヒューズ', 14);

  boxPart(240, 620, 60, 45, 'ZD1', 'RD5.1');
  label(225, 605, '保護', 14);
  wire(270, 620, 270, RAIL_5V, 2);
  dot(270, RAIL_5V);
  wire(270, 665, 270, RAIL_GND, 2);
  dot(270, RAIL_GND);

  // --- Test point + caution ---------------------------------------------------
  label(1180, 250, 'TP1', 15);
  wire(1200, 260, 1200, RAIL_5V, 2);
  dot(1200, RAIL_5V);
  label(1150, 230, '測定点', 14);

  label(60, 840, '注意: 高圧部に触れないこと', 15);

  return toFile(canvas, 'sample-japanese-psu-1of2.png');
}

// ---------------------------------------------------------------------------
// Sheet 2 — audio output stage
// ---------------------------------------------------------------------------

function buildAudioSheet(): Promise<File> {
  const { canvas, g } = newSheet();
  const { wire, dot, boxPart, label } = pen(g);

  label(40, 55, '音声出力回路図', 22);
  label(40, 80, 'AUDIO OUTPUT STAGE  (2/2)', 14, '400');

  // The same two rails as sheet 1, labelled identically -- this is what the
  // cross-sheet linker is meant to match.
  const RAIL_5V = 190;
  const RAIL_GND = 760;

  wire(140, RAIL_5V, 1300, RAIL_5V, 4);
  label(140, RAIL_5V - 12, '+5V', 17);

  wire(140, RAIL_GND, 1300, RAIL_GND, 4);
  label(140, RAIL_GND + 24, 'GND', 17);
  label(200, RAIL_GND + 24, '接地', 16);

  // --- Connector back to sheet 1 ---------------------------------------------
  g.lineWidth = 2;
  g.strokeRect(120, 400, 90, 130);
  g.font = '600 16px sans-serif';
  g.fillText('CN1', 120, 392);
  label(100, 560, '通信コネクタ', 14);
  label(105, 588, '← 1/2', 13, '400');

  wire(210, 430, 520, 430, 2);
  label(330, 422, 'SDA', 13);
  wire(210, 480, 520, 480, 2);
  label(330, 472, 'SCL', 13);

  // --- Audio processor --------------------------------------------------------
  g.lineWidth = 2;
  g.strokeRect(520, 380, 200, 190);
  g.font = '600 16px sans-serif';
  g.fillText('IC3', 520, 372);
  g.font = '14px sans-serif';
  g.fillText('TA7358AP', 545, 480);
  label(510, 350, '音声処理', 15);

  wire(560, 380, 560, RAIL_5V, 2);
  dot(560, RAIL_5V);
  wire(620, 570, 620, RAIL_GND, 2);
  dot(620, RAIL_GND);

  // --- Output stage -----------------------------------------------------------
  label(800, 330, '増幅回路', 16);
  boxPart(800, 400, 70, 50, 'Q1', '2SC1815');
  wire(720, 425, 800, 425, 2);
  wire(870, 425, 960, 425, 2);
  wire(835, 450, 835, RAIL_GND, 2);
  dot(835, RAIL_GND);

  boxPart(960, 400, 60, 45, 'C10', '10u');
  wire(1020, 422, 1120, 422, 2);
  label(1040, 412, '出力', 14);

  boxPart(900, 250, 60, 40, 'R10', '1k');
  wire(930, 250, 930, RAIL_5V, 2);
  dot(930, RAIL_5V);
  wire(930, 290, 930, 425, 2);
  dot(930, 425);

  // --- Speaker terminal -------------------------------------------------------
  g.lineWidth = 2;
  g.strokeRect(1120, 390, 80, 70);
  g.font = '600 16px sans-serif';
  g.fillText('CN5', 1120, 382);
  label(1110, 490, 'スピーカ', 14);
  wire(1160, 460, 1160, RAIL_GND, 2);
  dot(1160, RAIL_GND);

  // --- Decoupling and protection ----------------------------------------------
  boxPart(400, 250, 60, 40, 'C11', '100n');
  wire(430, 250, 430, RAIL_5V, 2);
  dot(430, RAIL_5V);
  wire(430, 290, 430, RAIL_GND, 2);
  dot(430, RAIL_GND);

  boxPart(280, 620, 60, 45, 'F2', '0.5A');
  label(270, 605, 'ヒューズ', 14);

  // --- Test point --------------------------------------------------------------
  label(1230, 250, 'TP2', 15);
  wire(1250, 262, 1250, RAIL_5V, 2);
  dot(1250, RAIL_5V);
  label(1200, 230, '測定点', 14);

  label(60, 840, '注意: 出力短絡に注意すること', 15);

  return toFile(canvas, 'sample-japanese-psu-2of2.png');
}
