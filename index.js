const express = require('express');
const cors = require('cors');
const { convertPDFToImages } = require('./pdfToImage');
const { detectHorizontalLines } = require('./lineDetector');
const { pixelToPDFCoordinates } = require('./coordinateMapper');
const { createFormFieldsOCR } = require('./formCreator');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PDF Form Generator - OCR Method',
    version: '1.0.0',
    method: 'Line Detection (Sharp + Custom Algorithm)',
    features: [
      'PDF to Image conversion (300 DPI)',
      'Horizontal line detection',
      'Pixel to PDF coordinate mapping',
      'Automatic field type classification',
      'Color-coded fields (signature, currency, text)'
    ],
    endpoints: {
      health: 'GET /',
      process: 'POST /process-ocr'
    }
  });
});

app.post('/process-ocr', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { pdf_url, extract_elements, options = {} } = req.body;
    
    // 驗證輸入
    if (!pdf_url) {
      return res.status(400).json({ 
        success: false, 
        error: 'pdf_url is required' 
      });
    }
    
    logger.info('='.repeat(60));
    logger.info('OCR Processing Started');
    logger.info(`PDF URL: ${pdf_url}`);
    logger.info('='.repeat(60));
    
    // Step 1: 下載 PDF
    logger.info('\n[Step 1] Downloading PDF...');
    const pdfResponse = await fetch(pdf_url);
    if (!pdfResponse.ok) {
      throw new Error(`Failed to download PDF: ${pdfResponse.statusText}`);
    }
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    logger.info(`✓ PDF downloaded: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);
    
    // Step 2: PDF → 圖片
    logger.info('\n[Step 2] Converting PDF to images...');
    const dpi = options.dpi || 300;
    const images = await convertPDFToImages(pdfBuffer, { dpi });
    logger.info(`✓ Converted ${images.length} pages to images (${dpi} DPI)`);
    
    // Step 3: 檢測每一頁的橫線
    logger.info('\n[Step 3] Detecting horizontal lines...');
    const allLines = [];
    
    for (let pageIndex = 0; pageIndex < images.length; pageIndex++) {
      const image = images[pageIndex];
      logger.info(`\n  Processing page ${pageIndex + 1}...`);
      
      const lines = await detectHorizontalLines(image.buffer, {
        minLength: options.minLineLength || 30,
        maxThickness: options.maxThickness || 3,
        threshold: options.threshold || 50
      });
      
      logger.info(`  ✓ Found ${lines.length} horizontal lines`);
      
      // 記錄前 5 條線的詳細信息
      lines.slice(0, 5).forEach((line, i) => {
        logger.info(`    Line ${i + 1}: X=${line.startX}-${line.endX}, Y=${line.y}, Length=${line.length}px`);
      });
      
      allLines.push({
        page: pageIndex,
        imageWidth: image.width,
        imageHeight: image.height,
        lines: lines
      });
    }
    
    const totalLines = allLines.reduce((sum, page) => sum + page.lines.length, 0);
    logger.info(`\n✓ Total lines detected: ${totalLines}`);
    
    // Step 4: 座標轉換 + 欄位分類
    logger.info('\n[Step 4] Converting coordinates and classifying fields...');
    const fillableAreas = [];
    let fieldIndex = 1;
    
    for (const pageData of allLines) {
      const { page, imageWidth, imageHeight, lines } = pageData;
      
      // 載入 PDF 以獲取頁面尺寸
      const { PDFDocument } = require('pdf-lib');
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const pdfPage = pdfDoc.getPages()[page];
      const pdfPageWidth = pdfPage.getWidth();
      const pdfPageHeight = pdfPage.getHeight();
      
      for (const line of lines) {
        // 像素座標 → PDF 座標
        const pdfCoords = pixelToPDFCoordinates(
          line.startX,
          line.y,
          imageWidth,
          imageHeight,
          pdfPageWidth,
          pdfPageHeight
        );
        
        const lineWidthInPDF = (line.length / imageWidth) * pdfPageWidth;
        
        // 欄位類型分類（結合 Adobe Extract 數據）
        let fieldType = 'text';
        
        if (extract_elements && Array.isArray(extract_elements)) {
          const nearbyText = findNearbyText(
            extract_elements, 
            page, 
            pdfCoords.x, 
            pdfCoords.y,
            pdfPageHeight
          );
          
          if (nearbyText) {
            fieldType = guessFieldType(nearbyText);
          }
        }
        
        fillableAreas.push({
          id: fieldIndex,
          field_name: `${fieldType}_${fieldIndex}`,
          page: page,
          x: pdfCoords.x,
          y: pdfCoords.y - 2, // 微調：稍微往下一點，貼合橫線
          width: lineWidthInPDF,
          height: 15, // 固定高度
          field_type: fieldType,
          metadata: {
            pixelCoords: {
              x: line.startX,
              y: line.y,
              length: line.length
            },
            imageSize: {
              width: imageWidth,
              height: imageHeight
            }
          }
        });
        
        fieldIndex++;
      }
    }
    
    logger.info(`✓ Created ${fillableAreas.length} field definitions`);
    
    // Step 5: 創建表單欄位
    logger.info('\n[Step 5] Creating form fields in PDF...');
    const { pdf_base64, statistics, errors } = await createFormFieldsOCR(
      pdfBuffer, 
      fillableAreas
    );
    
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    logger.info('\n' + '='.repeat(60));
    logger.info('OCR Processing Completed');
    logger.info(`Total time: ${processingTime}s`);
    logger.info(`Fields created: ${statistics.created_fields}/${statistics.detected_areas}`);
    logger.info(`Errors: ${statistics.errors}`);
    logger.info('='.repeat(60) + '\n');
    
    res.json({
      success: true,
      method: 'ocr',
      pdf_base64: pdf_base64,
      statistics: {
        ...statistics,
        processing_time_seconds: parseFloat(processingTime),
        pages_processed: images.length,
        lines_detected: totalLines
      },
      fields: fillableAreas.map(area => ({
        id: area.id,
        name: area.field_name,
        type: area.field_type,
        page: area.page,
        coordinates: {
          x: area.x.toFixed(2),
          y: area.y.toFixed(2),
          width: area.width.toFixed(2)
        }
      })),
      error_details: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    logger.error('\n[ERROR]', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// 輔助函數：找附近的文字
function findNearbyText(elements, page, x, y, pageHeight) {
  const searchRadius = 50; // 搜索半徑（PDF 單位）
  
  for (const element of elements) {
    if (element.Page !== page) continue;
    if (!element.Text || !element.Bounds) continue;
    
    const bounds = element.Bounds;
    const elementY = pageHeight - bounds[3]; // 轉換座標系統
    
    // 檢查橫線是否在這個文字元素附近（通常在下方）
    const yDistance = Math.abs(y - elementY);
    const xOverlap = x >= bounds[0] - searchRadius && x <= bounds[2] + searchRadius;
    
    if (yDistance < searchRadius && xOverlap) {
      return element.Text;
    }
  }
  
  return null;
}

// 輔助函數：猜測欄位類型
function guessFieldType(text) {
  const lower = text.toLowerCase();
  
  // 簽名
  if (lower.includes('sign') || lower.includes('signature')) {
    return 'signature';
  }
  
  // 金額
  if (lower.includes('$') || lower.includes('amount') || 
      lower.includes('sum') || lower.includes('price')) {
    return 'currency';
  }
  
  return 'text';
}

app.listen(PORT, () => {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`PDF Form Generator - OCR Method`);
  logger.info(`Version: 1.0.0`);
  logger.info(`Running on http://localhost:${PORT}`);
  logger.info(`Method: Line Detection (Sharp + Custom Algorithm)`);
  logger.info(`${'='.repeat(60)}\n`);
});

module.exports = app;