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
    service: 'PDF Form Generator - Triple Detection',
    version: '3.0.0',
    method: 'Three-Layer Detection System',
    features: [
      'Layer 1: Text underscore detection',
      'Layer 2: Long space detection',
      'Layer 3: Targeted region scanning',
      'Multiple lines per text block support'
    ]
  });
});

app.post('/process-ocr', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { pdf_url, extract_elements, options = {} } = req.body;
    
    if (!pdf_url) {
      return res.status(400).json({ success: false, error: 'pdf_url is required' });
    }
    
    logger.info('='.repeat(60));
    logger.info('Triple Detection Processing Started');
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
    
    // Step 2: 分析文字元素，找出可能的填答區域
    logger.info('\n[Step 2] Analyzing text elements...');
    const targetRegions = analyzeTextElements(extract_elements || []);
    
    logger.info(`✓ Found ${targetRegions.underscores} regions with underscores`);
    logger.info(`✓ Found ${targetRegions.longSpaces} regions with long spaces`);
    logger.info(`✓ Total target regions: ${targetRegions.all.length}`);
    
    // Step 3: PDF → 圖片
    logger.info('\n[Step 3] Converting PDF to images...');
    const dpi = options.dpi || 300;
    const images = await convertPDFToImages(pdfBuffer, { dpi });
    logger.info(`✓ Converted ${images.length} pages to images (${dpi} DPI)`);
    
    // Step 4: 精準掃描目標區域
    logger.info('\n[Step 4] Scanning target regions...');
    const fillableAreas = [];
    let fieldIndex = 1;
    let totalLinesDetected = 0;
    
    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    
    // 按頁面分組
    const regionsByPage = {};
    for (const region of targetRegions.all) {
      const page = region.page;
      if (!regionsByPage[page]) {
        regionsByPage[page] = [];
      }
      regionsByPage[page].push(region);
    }
    
    for (const pageIndex of Object.keys(regionsByPage).map(Number)) {
      const regions = regionsByPage[pageIndex];
      const image = images[pageIndex];
      
      if (!image) {
        logger.info(`  ⚠ Page ${pageIndex} image not found, skipping`);
        continue;
      }
      
      const pdfPage = pages[pageIndex];
      const pdfPageWidth = pdfPage.getWidth();
      const pdfPageHeight = pdfPage.getHeight();
      
      logger.info(`\n  Page ${pageIndex + 1}: ${regions.length} regions to scan`);
      
      for (const region of regions) {
        const bounds = region.bounds;
        const text = region.text;
        const expectedLines = region.expectedLines;
        
        // 計算像素座標
        const scaleX = image.width / pdfPageWidth;
        const scaleY = image.height / pdfPageHeight;
        
        const pixelX1 = Math.floor(bounds[0] * scaleX);
        const pixelY1 = Math.floor((pdfPageHeight - bounds[3]) * scaleY);
        const pixelX2 = Math.ceil(bounds[2] * scaleX);
        const pixelY2 = Math.ceil((pdfPageHeight - bounds[1]) * scaleY);
        
        // 加 padding
        const padding = 15;
        const safeX1 = Math.max(0, pixelX1 - padding);
        const safeY1 = Math.max(0, pixelY1 - padding);
        const safeX2 = Math.min(image.width, pixelX2 + padding);
        const safeY2 = Math.min(image.height, pixelY2 + padding);
        
        logger.info(`    Region (${region.type}): "${text.substring(0, 60)}..."`);
        logger.info(`      Expected lines: ${expectedLines}`);
        logger.info(`      Pixel region: [${safeX1}, ${safeY1}, ${safeX2}, ${safeY2}]`);
        
        // 在區域內檢測橫線
        const lines = await detectHorizontalLinesInRegion(
          image.buffer,
          image.width,
          image.height,
          {
            x: safeX1,
            y: safeY1,
            width: safeX2 - safeX1,
            height: safeY2 - safeY1
          },
          {
            minLength: options.minLineLength || 15,
            maxThickness: options.maxThickness || 3,
            threshold: options.threshold || 50
          }
        );
        
        logger.info(`      ✓ Found ${lines.length} lines (expected ${expectedLines})`);
        
        // 如果檢測到的線少於預期，警告
        if (lines.length < expectedLines) {
          logger.info(`      ⚠ Detected fewer lines than expected!`);
        }
        
        totalLinesDetected += lines.length;
        
        // 轉換為 PDF 座標並創建欄位
        for (const line of lines) {
          const absolutePixelX = safeX1 + line.startX;
          const absolutePixelY = safeY1 + line.y;
          
          const pdfX = absolutePixelX / scaleX;
          const pdfY = pdfPageHeight - (absolutePixelY / scaleY);
          const pdfWidth = line.length / scaleX;
          
          const fieldType = guessFieldType(text);
          
          fillableAreas.push({
            id: fieldIndex,
            field_name: `${fieldType}_${fieldIndex}`,
            page: pageIndex,
            x: pdfX,
            y: pdfY - 2,
            width: pdfWidth,
            height: 15,
            field_type: fieldType,
            metadata: {
              sourceText: text.substring(0, 100),
              detectionType: region.type,
              expectedLines: expectedLines
            }
          });
          
          fieldIndex++;
        }
      }
    }
    
    logger.info(`\n✓ Total lines detected: ${totalLinesDetected}`);
    logger.info(`✓ Total field definitions: ${fillableAreas.length}`);
    
    // Step 5: 創建表單欄位
    logger.info('\n[Step 5] Creating form fields in PDF...');
    const { pdf_base64, statistics, errors } = await createFormFieldsOCR(
      pdfBuffer, 
      fillableAreas
    );
    
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    logger.info('\n' + '='.repeat(60));
    logger.info('Triple Detection Processing Completed');
    logger.info(`Total time: ${processingTime}s`);
    logger.info(`Fields created: ${statistics.created_fields}/${statistics.detected_areas}`);
    logger.info(`Errors: ${statistics.errors}`);
    logger.info('='.repeat(60) + '\n');
    
    res.json({
      success: true,
      method: 'triple-detection',
      pdf_base64: pdf_base64,
      statistics: {
        ...statistics,
        processing_time_seconds: parseFloat(processingTime),
        pages_processed: images.length,
        regions_scanned: targetRegions.all.length,
        lines_detected: totalLinesDetected
      },
      fields: fillableAreas.map(area => ({
        id: area.id,
        name: area.field_name,
        type: area.field_type,
        page: area.page,
        source: area.metadata.detectionType,
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
 * 分析文字元素，找出所有可能的填答區域
 */
function analyzeTextElements(elements) {
  const regions = [];
  let underscoreCount = 0;
  let longSpaceCount = 0;
  
  for (const element of elements) {
    if (!element.Text || !element.Bounds) continue;
    
    const text = element.Text;
    const bounds = element.Bounds;
    const page = element.Page || 0;
    
    // 檢測 1: 下劃線字符 "___"
    const underscoreSegments = findUnderscoreSegments(text);
    if (underscoreSegments.length > 0) {
      regions.push({
        type: 'underscore',
        page: page,
        bounds: bounds,
        text: text,
        expectedLines: underscoreSegments.length,
        segments: underscoreSegments
      });
      underscoreCount++;
    }
    
    // 檢測 2: 異常長的空格（可能是填答框）
    const longSpaceSegments = findLongSpaceSegments(text);
    if (longSpaceSegments.length > 0) {
      regions.push({
        type: 'long-space',
        page: page,
        bounds: bounds,
        text: text,
        expectedLines: longSpaceSegments.length,
        segments: longSpaceSegments
      });
      longSpaceCount++;
    }
    
    // 檢測 3: 特殊模式（例如 "at:" 後面通常有填答框）
    if (hasFillingPattern(text)) {
      regions.push({
        type: 'pattern',
        page: page,
        bounds: bounds,
        text: text,
        expectedLines: 1,
        segments: []
      });
    }
  }
  
  return {
    all: regions,
    underscores: underscoreCount,
    longSpaces: longSpaceCount
  };
}

/**
 * 找出文字中的下劃線段落
 */
function findUnderscoreSegments(text) {
  const segments = [];
  const regex = /_{3,}/g; // 至少 3 個連續下劃線
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    segments.push({
      start: match.index,
      end: match.index + match[0].length,
      length: match[0].length
    });
  }
  
  return segments;
}

/**
 * 找出異常長的空格（可能是填答框）
 */
function findLongSpaceSegments(text) {
  const segments = [];
  const regex = / {8,}/g; // 至少 8 個連續空格
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    segments.push({
      start: match.index,
      end: match.index + match[0].length,
      length: match[0].length
    });
  }
  
  return segments;
}

/**
 * 檢測特殊填答模式
 */
function hasFillingPattern(text) {
  const patterns = [
    /at:\s*$/i,           // "located at:" 後面
    /of \$\s*\./i,        // "sum of $ ." 格式
    /amount of \$\s*$/i,  // "amount of $" 後面
    /company:\s*\./i      // "company: ." 格式
  ];
  
  return patterns.some(pattern => pattern.test(text));
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
  
  if (lower.includes('date')) {
    return 'date';
  }
  
  return 'text';
}

app.listen(PORT, () => {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`PDF Form Generator - Triple Detection`);
  logger.info(`Version: 3.0.0`);
  logger.info(`Running on http://localhost:${PORT}`);
  logger.info(`${'='.repeat(60)}\n`);
});

module.exports = app;