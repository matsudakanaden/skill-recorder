import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

export interface SessionStep {
  id?: string;
  timestamp: string;
  action: string;
  description?: string;
  imagePath?: string; // スクリーンショットのローカルパス
}

export interface SessionData {
  title?: string;
  createdAt?: string;
  steps: SessionStep[];
}

/**
 * Windows / Mac のシステムフォントパスを取得する関数
 */
function getSystemFontPath(): string | null {
  const fontPaths = [
    'C:\\Windows\\Fonts\\yugothm.ttc', // 游ゴシック (Windows)
    'C:\\Windows\\Fonts\\msgothic.ttc', // ＭＳ ゴシック (Windows)
    '/System/Library/Fonts/Hiragino Sans GB.ttc', // Mac
    '/System/Library/Fonts/Supplemental/Arial.ttf'
  ];

  for (const fontPath of fontPaths) {
    if (fs.existsSync(fontPath)) {
      return fontPath;
    }
  }
  return null;
}

/**
 * セッションデータを単一のPDFファイルとして出力する
 */
export async function exportSessionToPdf(
  sessionData: SessionData,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        autoFirstPage: true,
      });

      const writeStream = fs.createWriteStream(outputPath);
      doc.pipe(writeStream);

      // 日本語フォントの設定
      const fontPath = getSystemFontPath();
      if (fontPath) {
        doc.font(fontPath);
      }

      // --- 1. タイトルヘッダー ---
      doc
        .fontSize(20)
        .text(sessionData.title || 'デスクトップ操作記録レポート', { align: 'left' });
      
      doc
        .fontSize(10)
        .fillColor('#666666')
        .text(`作成日時: ${sessionData.createdAt || new Date().toLocaleString('ja-JP')}`);
      
      doc.moveDown(1);
      doc.strokeColor('#CCCCCC').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(1.5);

      // --- 2. 各ステップの出力 ---
      doc.fillColor('#000000').fontSize(14).text('【操作ステップ一覧】');
      doc.moveDown(1);

      sessionData.steps.forEach((step, index) => {
        // ページ末尾に近づいたら自動改ページ
        if (doc.y > 650) {
          doc.addPage();
        }

        doc
          .fontSize(12)
          .fillColor('#003366')
          .text(`Step ${index + 1}: ${step.action} (${step.timestamp})`, { underline: true });

        if (step.description) {
          doc
            .fontSize(10)
            .fillColor('#333333')
            .text(`詳細: ${step.description}`);
        }

        doc.moveDown(0.5);

        // スクリーンショット画像の挿入
        if (step.imagePath && fs.existsSync(step.imagePath)) {
          try {
            // A4幅に合わせて画像サイズを調整（幅最大450px）
            doc.image(step.imagePath, {
              fit: [450, 250],
              align: 'center',
              valign: 'center',
            });
            doc.moveDown(1);
          } catch (imgError) {
            console.warn(`画像の読み込みに失敗しました: ${step.imagePath}`, imgError);
          }
        }

        doc.moveDown(1);
        doc.strokeColor('#EEEEEE').lineWidth(0.5).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(1);
      });

      doc.end();

      writeStream.on('finish', () => {
        resolve();
      });

      writeStream.on('error', (err) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}
