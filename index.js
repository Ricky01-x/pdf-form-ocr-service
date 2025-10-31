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

// 在 index.js 的 process-ocr 端點中修改

app.post('/process-ocr', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { pdf_url, extract_elements, options = {} } = req.body;
    
    if (!pdf_url) {
      return res.status(400).json({ success: false, error: 'pdf_url is required' });
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
    
    // ===== 新增：從 Adobe Extract 提取下劃線位置 =====
    logger.info('\n[Step 1.5] Extracting underscores from Adobe Extract data...');
    const textUnderscores = extractUnderscoresFromElements(extract_elements);
    logger.info(`✓ Found ${textUnderscores.length} underscore segments in text`);
    
    // Step 2: PDF → 圖片
    logger.info('\n[Step 2] Converting PDF to images...');
    const dpi = options.dpi || 300;
    const images = await convertPDFToImages(pdfBuffer, { dpi });
    logger.info(`✓ Converted ${images.length} pages to images (${dpi} DPI)`);
    
    // Step 3: 檢測圖形層的橫線
    logger.info('\n[Step 3] Detecting graphical lines...');
    const graphicalLines = [];
    
    for (let pageIndex = 0; pageIndex < images.length; pageIndex++) {
      const image = images[pageIndex];
      logger.info(`\n  Processing page ${pageIndex + 1}...`);
      
      const lines = await detectHorizontalLines(image.buffer, {
        minLength: options.minLineLength || 30,
        maxThickness: options.maxThickness || 3,
        threshold: options.threshold || 50
      });
      
      logger.info(`  ✓ Found ${lines.length} graphical lines`);
      
      graphicalLines.push({
        page: pageIndex,
        imageWidth: image.width,
        imageHeight: image.height,
        lines: lines
      });
    }
    
    const totalGraphicalLines = graphicalLines.reduce((sum, page) => sum + page.lines.length, 0);
    logger.info(`\n✓ Total graphical lines: ${totalGraphicalLines}`);
    logger.info(`✓ Total text underscores: ${textUnderscores.length}`);
    
    // Step 4: 合併兩種來源的欄位
    logger.info('\n[Step 4] Merging fields from both sources...');
    const fillableAreas = [];
    let fieldIndex = 1;
    
    // 載入 PDF 以獲取頁面尺寸
    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    
    // 4A: 添加文字層的下劃線欄位
    for (const underscore of textUnderscores) {
      const page = pages[underscore.page];
      if (!page) continue;
      
      const pdfPageHeight = page.getHeight();
      
      fillableAreas.push({
        id: fieldIndex,
        field_name: `${underscore.fieldType}_${fieldIndex}`,
        page: underscore.page,
        x: underscore.x,
        y: pdfPageHeight - underscore.y - underscore.height, // PDF 座標轉換
        width: underscore.width,
        height: underscore.height,
        field_type: underscore.fieldType,
        source: 'text',
        metadata: {
          text: underscore.text,
          context: underscore.context
        }
      });
      
      fieldIndex++;
    }
    
    logger.info(`✓ Added ${textUnderscores.length} fields from text layer`);
    
    // 4B: 添加圖形層的線條欄位
    for (const pageData of graphicalLines) {
      const { page, imageWidth, imageHeight, lines } = pageData;
      const pdfPage = pages[page];
      if (!pdfPage) continue;
      
      const pdfPageWidth = pdfPage.getWidth();
      const pdfPageHeight = pdfPage.getHeight();
      
      for (const line of lines) {
        const pdfCoords = pixelToPDFCoordinates(
          line.startX,
          line.y,
          imageWidth,
          imageHeight,
          pdfPageWidth,
          pdfPageHeight
        );
        
        const lineWidthInPDF = (line.length / imageWidth) * pdfPageWidth;
        
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
          y: pdfCoords.y - 2,
          width: lineWidthInPDF,
          height: 15,
          field_type: fieldType,
          source: 'graphical',
          metadata: {
            pixelCoords: {
              x: line.startX,
              y: line.y,
              length: line.length
            }
          }
        });
        
        fieldIndex++;
      }
    }
    
    logger.info(`✓ Added ${totalGraphicalLines} fields from graphical layer`);
    logger.info(`✓ Total field definitions: ${fillableAreas.length}`);
    
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
    logger.info(`  From text layer: ${textUnderscores.length}`);
    logger.info(`  From graphical layer: ${totalGraphicalLines}`);
    logger.info(`Errors: ${statistics.errors}`);
    logger.info('='.repeat(60) + '\n');
    
    res.json({
      success: true,
      method: 'hybrid',
      pdf_base64: pdf_base64,
      statistics: {
        ...statistics,
        processing_time_seconds: parseFloat(processingTime),
        pages_processed: images.length,
        text_underscores: textUnderscores.length,
        graphical_lines: totalGraphicalLines
      },
      fields: fillableAreas.map(area => ({
        id: area.id,
        name: area.field_name,
        type: area.field_type,
        page: area.page,
        source: area.source,
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

// ===== 新增：從 Adobe Extract 元素中提取下劃線 =====
function extractUnderscoresFromElements(elements) {
  if (!elements || !Array.isArray(elements)) {
    return [];
  }
  
  const underscores = [];
  
  for (const element of elements) {
    if (!element.Text || !element.Bounds) continue;
    
    const text = element.Text;
    const bounds = element.Bounds; // [x1, y1, x2, y2]
    const page = element.Page || 0;
    
    // 找出所有下劃線段落
    const segments = findUnderscoreSegments(text, 3); // 至少 3 個連續下劃線
    
    if (segments.length === 0) continue;
    
    // 估算字符寬度
    const textWidth = bounds[2] - bounds[0];
    const charWidth = textWidth / text.length;
    
    for (const segment of segments) {
      const startX = bounds[0] + (segment.startIndex * charWidth);
      const width = segment.length * charWidth;
      
      // 獲取上下文
      const context = getContext(text, segment.startIndex, segment.endIndex);
      const fieldType = guessFieldType(context, text);
      
      underscores.push({
        page: page,
        x: startX,
        y: bounds[1],
        width: width,
        height: bounds[3] - bounds[1],
        fieldType: fieldType,
        text: text,
        context: context,
        segment: segment
      });
    }
  }
  
  return underscores;
}

// 找下劃線段落
function findUnderscoreSegments(text, minLength = 3) {
  const segments = [];
  let i = 0;
  
  while (i < text.length) {
    if (text[i] === '_') {
      const startIndex = i;
      let count = 0;
      
      while (i < text.length && (text[i] === '_' || text[i] === ' ')) {
        if (text[i] === '_') count++;
        i++;
      }
      
      if (count >= minLength) {
        segments.push({
          startIndex: startIndex,
          endIndex: i - 1,
          length: count
        });
      }
    } else {
      i++;
    }
  }
  
  return segments;
}

function getContext(text, startIndex, endIndex) {
  const beforeStart = Math.max(0, startIndex - 50);
  const afterEnd = Math.min(text.length, endIndex + 50);
  
  const before = text.substring(beforeStart, startIndex).trim();
  const after = text.substring(endIndex + 1, afterEnd).trim();
  
  return { before, after, full: before + ' _____ ' + after };
}

function guessFieldType(context, text = '') {
  const beforeLower = context.before.toLowerCase();
  const afterLower = context.after.toLowerCase();
  const combined = (beforeLower + ' ' + afterLower + ' ' + text).toLowerCase();
  
  if (combined.includes('sign') || combined.includes('signature')) {
    return 'signature';
  }
  
  if (combined.includes('$') || combined.includes('amount') || 
      combined.includes('sum of') || combined.includes('price')) {
    return 'currency';
  }
  
  return 'text';
}

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