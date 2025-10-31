const express = require('express');
const cors = require('cors');
const { convertPDFToImages } = require('./pdfToImage');
const { detectHorizontalLinesInRegion } = require('./lineDetector');
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
    service: 'PDF Form Generator - Hybrid OCR Method',
    version: '2.0.0',
    method: 'Text-Guided Regional Line Detection',
    features: [
      'Adobe Extract text analysis',
      'Regional image cropping',
      'Precise line detection in text regions',
      'No false positives from logos'
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
    
    if (!pdf_url) {
      return res.status(400).json({ success: false, error: 'pdf_url is required' });
    }
    
    if (!extract_elements || !Array.isArray(extract_elements)) {
      return res.status(400).json({ 
        success: false, 
        error: 'extract_elements array is required for text-guided detection' 
      });
    }
    
    logger.info('='.repeat(60));
    logger.info('Hybrid OCR Processing Started');
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
    
    // Step 2: 從 Adobe Extract 找出包含下劃線的文字區域
    logger.info('\n[Step 2] Analyzing text elements for underscores...');
    const regionsWithUnderscores = findRegionsWithUnderscores(extract_elements);
    logger.info(`✓ Found ${regionsWithUnderscores.length} text regions with underscores`);
    
    if (regionsWithUnderscores.length === 0) {
      logger.info('⚠ No underscores found in text, falling back to full-page scan');
    }
    
    // Step 3: PDF → 圖片（全頁）
    logger.info('\n[Step 3] Converting PDF to images...');
    const dpi = options.dpi || 300;
    const images = await convertPDFToImages(pdfBuffer, { dpi });
    logger.info(`✓ Converted ${images.length} pages to images (${dpi} DPI)`);
    
    // Step 4: 載入 PDF 獲取頁面尺寸
    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pdfPages = pdfDoc.getPages();
    
    // Step 5: 對每個包含下劃線的區域進行精確檢測
    logger.info('\n[Step 4] Detecting lines in text regions...');
    const fillableAreas = [];
    let fieldIndex = 1;
    let totalLinesDetected = 0;
    
    for (const region of regionsWithUnderscores) {
      const pageImage = images[region.page];
      if (!pageImage) continue;
      
      const pdfPage = pdfPages[region.page];
      if (!pdfPage) continue;
      
      const pdfPageWidth = pdfPage.getWidth();
      const pdfPageHeight = pdfPage.getHeight();
      
      // 將 PDF 座標轉換為圖片像素座標
      const imageRegion = pdfBoundsToImageBounds(
        region.bounds,
        pageImage.width,
        pageImage.height,
        pdfPageWidth,
        pdfPageHeight
      );
      
      logger.info(`  Page ${region.page + 1}, Region: "${region.text.substring(0, 50)}..."`);
      logger.info(`    PDF Bounds: [${region.bounds.map(b => b.toFixed(0)).join(', ')}]`);
      logger.info(`    Image Region: [${imageRegion.map(b => b.toFixed(0)).join(', ')}]`);
      
      // 在該區域中檢測橫線
      const lines = await detectHorizontalLinesInRegion(
        pageImage.buffer,
        imageRegion,
        {
          minLength: options.minLineLength || 20,
          maxThickness: options.maxThickness || 3,
          threshold: options.threshold || 50
        }
      );
      
      logger.info(`    ✓ Detected ${lines.length} lines in this region`);
      totalLinesDetected += lines.length;
      
      // 轉換回 PDF 座標並創建欄位
      for (const line of lines) {
        const pdfCoords = pixelToPDFCoordinates(
          line.startX,
          line.y,
          pageImage.width,
          pageImage.height,
          pdfPageWidth,
          pdfPageHeight
        );
        
        const lineWidthInPDF = (line.length / pageImage.width) * pdfPageWidth;
        
        // 根據文字內容猜測欄位類型
        const fieldType = guessFieldType(region.text);
        
        fillableAreas.push({
          id: fieldIndex,
          field_name: `${fieldType}_${fieldIndex}`,
          page: region.page,
          x: pdfCoords.x,
          y: pdfCoords.y - 2,
          width: lineWidthInPDF,
          height: 15,
          field_type: fieldType,
          metadata: {
            textContext: region.text.substring(0, 100),
            detectionMethod: 'regional'
          }
        });
        
        fieldIndex++;
      }
    }
    
    logger.info(`\n✓ Total lines detected: ${totalLinesDetected}`);
    logger.info(`✓ Total fields created: ${fillableAreas.length}`);
    
    // Step 6: 創建表單欄位
    logger.info('\n[Step 5] Creating form fields in PDF...');
    const { pdf_base64, statistics, errors } = await createFormFieldsOCR(
      pdfBuffer, 
      fillableAreas
    );
    
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    logger.info('\n' + '='.repeat(60));
    logger.info('Hybrid OCR Processing Completed');
    logger.info(`Total time: ${processingTime}s`);
    logger.info(`Fields created: ${statistics.created_fields}/${statistics.detected_areas}`);
    logger.info(`Errors: ${statistics.errors}`);
    logger.info('='.repeat(60) + '\n');
    
    res.json({
      success: true,
      method: 'hybrid-regional',
      pdf_base64: pdf_base64,
      statistics: {
        ...statistics,
        processing_time_seconds: parseFloat(processingTime),
        pages_processed: images.length,
        text_regions_analyzed: regionsWithUnderscores.length,
        lines_detected: totalLinesDetected
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

/**
 * 從 Adobe Extract 元素中找出包含下劃線的區域
 */
function findRegionsWithUnderscores(elements) {
  const regions = [];
  
  for (const element of elements) {
    if (!element.Text || !element.Bounds) continue;
    
    const text = element.Text;
    
    // 檢查是否包含至少 3 個連續下劃線
    if (hasUnderscores(text, 3)) {
      regions.push({
        page: element.Page || 0,
        text: text,
        bounds: element.Bounds, // [x1, y1, x2, y2]
        font: element.Font
      });
    }
  }
  
  return regions;
}

/**
 * 檢查文字是否包含連續下劃線
 */
function hasUnderscores(text, minCount = 3) {
  let maxConsecutive = 0;
  let currentCount = 0;
  
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '_') {
      currentCount++;
      maxConsecutive = Math.max(maxConsecutive, currentCount);
    } else if (text[i] !== ' ') { // 允許空格
      currentCount = 0;
    }
  }
  
  return maxConsecutive >= minCount;
}

/**
 * 將 PDF 座標轉換為圖片像素座標
 */
function pdfBoundsToImageBounds(pdfBounds, imageWidth, imageHeight, pdfPageWidth, pdfPageHeight) {
  // pdfBounds: [x1, y1, x2, y2] (PDF 座標，原點左下)
  // 返回: [x1, y1, x2, y2] (圖片座標，原點左上)
  
  const scaleX = imageWidth / pdfPageWidth;
  const scaleY = imageHeight / pdfPageHeight;
  
  const x1 = pdfBounds[0] * scaleX;
  const y1 = imageHeight - (pdfBounds[3] * scaleY); // 翻轉 Y 軸
  const x2 = pdfBounds[2] * scaleX;
  const y2 = imageHeight - (pdfBounds[1] * scaleY); // 翻轉 Y 軸
  
  // 添加邊距（上下各 20 像素，左右各 10 像素）
  const padding = {
    top: 20,
    bottom: 20,
    left: 10,
    right: 10
  };
  
  return [
    Math.max(0, x1 - padding.left),
    Math.max(0, y1 - padding.top),
    Math.min(imageWidth, x2 + padding.right),
    Math.min(imageHeight, y2 + padding.bottom)
  ];
}

/**
 * 猜測欄位類型
 */
function guessFieldType(text) {
  const lower = text.toLowerCase();
  
  if (lower.includes('sign') || lower.includes('signature')) {
    return 'signature';
  }
  
  if (lower.includes('$') || lower.includes('amount') || 
      lower.includes('sum') || lower.includes('price')) {
    return 'currency';
  }
  
  return 'text';
}

app.listen(PORT, () => {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`PDF Form Generator - Hybrid OCR Method`);
  logger.info(`Version: 2.0.0`);
  logger.info(`Running on http://localhost:${PORT}`);
  logger.info(`Method: Text-Guided Regional Line Detection`);
  logger.info(`${'='.repeat(60)}\n`);
});

module.exports = app;