const { PDFDocument, rgb, StandardFonts, PDFName, PDFString } = require('pdf-lib');

/**
 * 在 PDF 中創建表單欄位（基於 OCR 檢測的座標）
 */
async function createFormFieldsOCR(pdfBuffer, fillableAreas) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  const form = pdfDoc.getForm();
  
  // ❌ 移除這行！會導致字體問題
  // const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  
  let successCount = 0;
  let errorCount = 0;
  const errors = [];
  
  for (const area of fillableAreas) {
    try {
      const page = pages[area.page];
      if (!page) {
        throw new Error(`Page ${area.page} not found`);
      }
      
      const pageHeight = page.getHeight();
      const pageWidth = page.getWidth();
      
      // 確保座標在頁面範圍內
      let safeX = Math.max(0, Math.min(area.x, pageWidth - 10));
      let safeY = Math.max(0, Math.min(area.y, pageHeight - 5));
      let safeWidth = Math.max(10, Math.min(area.width, pageWidth - safeX));
      let safeHeight = Math.max(5, Math.min(area.height, pageHeight - safeY));
      
      // 創建文字欄位
      const textField = form.createTextField(area.field_name);
      textField.setText('');
      
      // ✅ 簡化字體設置 - 不嵌入字體
      const fontSize = Math.max(8, Math.min(safeHeight * 0.6, 12));
      
      // ❌ 移除複雜的字體設置
      // const acroField = textField.acroField;
      // const defaultAppearance = `0 0 0 rg /Helv ${fontSize} Tf`;
      // acroField.dict.set(PDFName.of('DA'), PDFString.of(defaultAppearance));
      
      // 根據類型設置顏色
      let borderColor, backgroundColor;
      
      if (area.field_type === 'signature') {
        borderColor = rgb(0, 0, 1);           // 藍色
        backgroundColor = rgb(0.9, 0.9, 1);
      } else if (area.field_type === 'currency') {
        borderColor = rgb(0, 0.6, 0);         // 綠色
        backgroundColor = rgb(0.9, 1, 0.9);
      } else {
        borderColor = rgb(0.7, 0.7, 0.7);     // 灰色
        backgroundColor = rgb(1, 1, 1);
      }
      
      textField.addToPage(page, {
        x: safeX,
        y: safeY,
        width: safeWidth,
        height: safeHeight,
        borderWidth: 1,
        borderColor: borderColor,
        backgroundColor: backgroundColor,
      });
      
      // ❌ 移除字體更新
      // try {
      //   textField.updateAppearances(helveticaFont);
      // } catch (e) {
      //   // 忽略外觀更新錯誤
      // }
      
      successCount++;
      
      if (successCount % 20 === 0) {
        console.log(`  Created ${successCount}/${fillableAreas.length} fields`);
      }
      
    } catch (error) {
      errorCount++;
      errors.push(`${area.field_name}: ${error.message}`);
      console.error(`  ✗ ${area.field_name}: ${error.message}`);
    }
  }
  
  console.log(`\n✓ Completed: ${successCount} created, ${errorCount} errors`);
  
  // ✅ 使用基本保存選項
  const pdfBytes = await pdfDoc.save({
    useObjectStreams: false,  // 兼容性更好
    addDefaultPage: false
  });
  
  const base64Pdf = Buffer.from(pdfBytes).toString('base64');
  
  const fieldStats = {
    text: fillableAreas.filter(f => f.field_type === 'text').length,
    signature: fillableAreas.filter(f => f.field_type === 'signature').length,
    currency: fillableAreas.filter(f => f.field_type === 'currency').length
  };
  
  return {
    pdf_base64: base64Pdf,
    statistics: {
      detected_areas: fillableAreas.length,
      created_fields: successCount,
      errors: errorCount,
      ...fieldStats
    },
    errors: errors
  };
}

module.exports = {
  createFormFieldsOCR
};