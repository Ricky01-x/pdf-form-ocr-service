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
    logger.info('Hybrid Scanning Started');
    logger.info('='.repeat(60));
    
    // Step 1: 下載 PDF
    logger.info('\n[Step 1] Downloading PDF...');
    const pdfResponse = await fetch(pdf_url);
    if (!pdfResponse.ok) {
      throw new Error(`Failed to download PDF: ${pdfResponse.statusText}`);
    }
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    logger.info(`✓ PDF downloaded: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);
    
    // Step 2: 分析文字元素（精準掃描區域）
    logger.info('\n[Step 2] Analyzing text for targeted scanning...');
    const targetRegions = analyzeTextElements(extract_elements || []);
    logger.info(`✓ Found ${targetRegions.all.length} targeted regions from text analysis`);
    
    // Step 3: PDF → 圖片
    logger.info('\n[Step 3] Converting PDF to images...');
    const dpi = options.dpi || 300;
    const images = await convertPDFToImages(pdfBuffer, { dpi });
    logger.info(`✓ Converted ${images.length} pages to images (${dpi} DPI)`);
    
    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    
    const fillableAreas = [];
    let fieldIndex = 1;
    
    // ========== 階段 A: 精準掃描（文字引導） ==========
    logger.info('\n[Step 4A] Targeted region scanning...');
    let targetedLinesCount = 0;
    
    const regionsByPage = {};
    for (const region of targetRegions.all) {
      const page = region.page;
      if (!regionsByPage[page]) regionsByPage[page] = [];
      regionsByPage[page].push(region);
    }
    
    const scannedAreas = []; // 記錄已掃描區域，避免重複
    
    for (const pageIndex of Object.keys(regionsByPage).map(Number)) {
      const regions = regionsByPage[pageIndex];
      const image = images[pageIndex];
      if (!image) continue;
      
      const pdfPage = pages[pageIndex];
      const pdfPageWidth = pdfPage.getWidth();
      const pdfPageHeight = pdfPage.getHeight();
      const scaleX = image.width / pdfPageWidth;
      const scaleY = image.height / pdfPageHeight;
      
      logger.info(`  Page ${pageIndex + 1}: ${regions.length} targeted regions`);
      
      for (const region of regions) {
        const bounds = region.bounds;
        const text = region.text;
        
        const pixelX1 = Math.floor(bounds[0] * scaleX);
        const pixelY1 = Math.floor((pdfPageHeight - bounds[3]) * scaleY);
        const pixelX2 = Math.ceil(bounds[2] * scaleX);
        const pixelY2 = Math.ceil((pdfPageHeight - bounds[1]) * scaleY);
        
        const padding = 15;
        const safeRegion = {
          x: Math.max(0, pixelX1 - padding),
          y: Math.max(0, pixelY1 - padding),
          width: Math.min(image.width, pixelX2 + padding) - Math.max(0, pixelX1 - padding),
          height: Math.min(image.height, pixelY2 + padding) - Math.max(0, pixelY1 - padding)
        };
        
        // 記錄已掃描區域
        scannedAreas.push({
          page: pageIndex,
          ...safeRegion
        });
        
        const lines = await detectHorizontalLinesInRegion(
          image.buffer,
          image.width,
          image.height,
          safeRegion,
          {
            minLength: 15,
            maxThickness: 3,
            threshold: 50
          }
        );
        
        targetedLinesCount += lines.length;
        
        for (const line of lines) {
          const absolutePixelX = safeRegion.x + line.startX;
          const absolutePixelY = safeRegion.y + line.y;
          const pdfX = absolutePixelX / scaleX;
          const pdfY = pdfPageHeight - (absolutePixelY / scaleY);
          const pdfWidth = line.length / scaleX;
          
          fillableAreas.push({
            id: fieldIndex++,
            field_name: `text_${fieldIndex}`,
            page: pageIndex,
            x: pdfX,
            y: pdfY - 2,
            width: pdfWidth,
            height: 15,
            field_type: guessFieldType(text),
            source: 'targeted',
            metadata: { sourceText: text.substring(0, 60) }
          });
        }
      }
    }
    
    logger.info(`✓ Targeted scanning found ${targetedLinesCount} lines`);
    
    // ========== 階段 B: 全頁補充掃描（智能過濾） ==========
    logger.info('\n[Step 4B] Full-page補充 scanning with smart filtering...');
    let supplementalLinesCount = 0;
    
    for (let pageIndex = 0; pageIndex < images.length; pageIndex++) {
      const image = images[pageIndex];
      const pdfPage = pages[pageIndex];
      const pdfPageWidth = pdfPage.getWidth();
      const pdfPageHeight = pdfPage.getHeight();
      const scaleX = image.width / pdfPageWidth;
      const scaleY = image.height / pdfPageHeight;
      
      logger.info(`  Page ${pageIndex + 1}: Full-page scan with Logo exclusion`);
      
      // 全頁掃描
      const allLines = await detectHorizontalLinesInRegion(
        image.buffer,
        image.width,
        image.height,
        {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height
        },
        {
          minLength: 40, // 更嚴格
          maxThickness: 3,
          threshold: 50
        }
      );
      
      // 智能過濾
      const filteredLines = allLines.filter(line => {
        const absolutePixelY = line.y;
        
        // 1. 排除頂部 Logo 區域 (前 12%)
        if (absolutePixelY < image.height * 0.12) {
          return false;
        }
        
        // 2. 排除底部頁碼區域 (後 3%)
        if (absolutePixelY > image.height * 0.97) {
          return false;
        }
        
        // 3. 排除左右邊緣
        if (line.startX < image.width * 0.08 || line.startX > image.width * 0.92) {
          return false;
        }
        
        // 4. 排除已在精準掃描中找到的區域
        const absolutePixelX = line.startX;
        for (const scanned of scannedAreas.filter(a => a.page === pageIndex)) {
          if (absolutePixelX >= scanned.x && 
              absolutePixelX <= scanned.x + scanned.width &&
              absolutePixelY >= scanned.y && 
              absolutePixelY <= scanned.y + scanned.height) {
            return false; // 已掃描過，跳過
          }
        }
        
        return true;
      });
      
      logger.info(`    Found ${filteredLines.length} supplemental lines (filtered from ${allLines.length})`);
      supplementalLinesCount += filteredLines.length;
      
      for (const line of filteredLines) {
        const pdfX = line.startX / scaleX;
        const pdfY = pdfPageHeight - (line.y / scaleY);
        const pdfWidth = line.length / scaleX;
        
        fillableAreas.push({
          id: fieldIndex++,
          field_name: `text_${fieldIndex}`,
          page: pageIndex,
          x: pdfX,
          y: pdfY - 2,
          width: pdfWidth,
          height: 15,
          field_type: 'text',
          source: 'supplemental',
          metadata: {}
        });
      }
    }
    
    logger.info(`✓ Supplemental scanning found ${supplementalLinesCount} additional lines`);
    logger.info(`✓ Total fields: ${fillableAreas.length}`);
    
    // Step 5: 創建表單欄位
    logger.info('\n[Step 5] Creating form fields...');
    const { pdf_base64, statistics, errors } = await createFormFieldsOCR(
      pdfBuffer, 
      fillableAreas
    );
    
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    logger.info('\n' + '='.repeat(60));
    logger.info('Processing Completed');
    logger.info(`Total time: ${processingTime}s`);
    logger.info(`Fields created: ${statistics.created_fields}`);
    logger.info(`  - From targeted scanning: ${targetedLinesCount}`);
    logger.info(`  - From supplemental scanning: ${supplementalLinesCount}`);
    logger.info('='.repeat(60) + '\n');
    
    res.json({
      success: true,
      method: 'hybrid-scanning',
      pdf_base64: pdf_base64,
      statistics: {
        ...statistics,
        processing_time_seconds: parseFloat(processingTime),
        pages_processed: images.length,
        targeted_lines: targetedLinesCount,
        supplemental_lines: supplementalLinesCount
      },
      fields: fillableAreas.map(area => ({
        id: area.id,
        name: area.field_name,
        type: area.field_type,
        page: area.page,
        source: area.source
      })),
      error_details: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    logger.error('\n[ERROR]', error);
    res.status(500).json({
      success: false,
      error: error.message
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