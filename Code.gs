/**
 * Calculadora de aguinaldo México 2026
 * Google Apps Script + HtmlService (barra lateral)
 *
 * La lógica fiscal NO está duplicada en fórmulas de hoja: los parámetros se
 * leen de la hoja "Parámetros" y el cálculo se ejecuta aquí. La hoja "Cálculo"
 * guarda un comprobante del último resultado y la hoja "Notas" documenta
 * fuentes, supuestos y limitaciones.
 *
 * Importante: la exención de ISR del aguinaldo son 30 UMA DIARIAS
 * (30 x UMA diaria), no 30 veces la UMA anual. Ver hoja "Notas".
 */

const HOJA_PARAMETROS = 'Parámetros';
const HOJA_CALCULO = 'Cálculo';
const HOJA_NOTAS = 'Notas';

const FORMATO_MONEDA = '"$"#,##0.00';
const FORMATO_FECHA = 'dd/mm/yyyy';
const FORMATO_NUMERO = '#,##0.0000';
const FORMATO_PORCENTAJE = '0.0000%';
const MS_DIA = 24 * 60 * 60 * 1000;

/**
 * Menú de la hoja. No ejecuta servicios que requieran autorización.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Aguinaldo 2026')
    .addItem('Abrir calculadora', 'mostrarCalculadora')
    .addItem('Instalar / reparar hojas', 'instalar')
    .addSeparator()
    .addItem('Ver notas y fuentes', 'abrirNotas')
    .addToUi();
}

/**
 * Instalación inicial. Ejecutar una vez desde el editor para autorizar.
 */
function instalar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  crearEstructura_(ss);

  const mensaje =
    'Hojas instaladas correctamente.\n\n' +
    'Recarga la hoja y usa el menú "Aguinaldo 2026" > "Abrir calculadora".\n\n' +
    'Los parámetros están en la hoja "Parámetros"; las fuentes y supuestos en "Notas".';

  try {
    SpreadsheetApp.getUi().alert(mensaje);
  } catch (error) {
    // Al ejecutar desde el editor no siempre hay una UI de hoja disponible.
    // Las hojas ya quedaron creadas; el mensaje se registra para diagnóstico.
    Logger.log(mensaje);
  }
}

/**
 * Abre la calculadora en una barra lateral.
 */
function mostrarCalculadora() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  crearEstructura_(ss);
  const html = HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Calculadora de aguinaldo 2026')
    .setWidth(460);
  // En Google Sheets la barra lateral se muestra desde la Ui del contenedor,
  // no desde el objeto Spreadsheet.
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Activa la hoja de notas.
 */
function abrirNotas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  crearEstructura_(ss);
  const hoja = ss.getSheetByName(HOJA_NOTAS);
  if (hoja) ss.setActiveSheet(hoja);
}

/**
 * Datos iniciales para el formulario.
 * @return {Object}
 */
function obtenerDatosIniciales() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  crearEstructura_(ss);
  const p = obtenerParametros_(ss);
  const limiteExento = redondear2_(p.umaDiaria * p.diasUmaExentos);

  return {
    ok: true,
    anioFiscal: p.anioFiscal,
    fechaMinima: p.anioFiscal + '-01-01',
    fechaMaxima: p.anioFiscal + '-12-31',
    fechaCorteSugerida: p.anioFiscal + '-12-31',
    umaDiaria: p.umaDiaria,
    umaDiariaFormateada: formatearMoneda_(p.umaDiaria),
    diasAguinaldo: p.diasAguinaldo,
    diasUmaExentos: p.diasUmaExentos,
    limiteExento: limiteExento,
    limiteExentoFormateado: formatearMoneda_(limiteExento),
    actualizacion: p.fechaActualizacion,
    fuenteUma: 'INEGI / DOF 09/01/2026',
    fuenteIsr: 'SAT Anexo 8 RMF 2026 / DOF 28/12/2025'
  };
}

/**
 * Punto de entrada del cálculo desde la barra lateral.
 *
 * @param {Object} datos {salarioMensual, fechaIngreso, fechaCorte, otrasDeducciones}
 * @return {Object} Resultado estructurado; nunca devuelve datos sin validar.
 */
function calcularAguinaldo(datos) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  crearEstructura_(ss);
  const p = obtenerParametros_(ss);
  const validacion = validarEntrada_(datos, p);

  if (!validacion.ok) {
    return { ok: false, errores: validacion.errores };
  }

  const entrada = validacion.datos;
  const salarioDiario = entrada.salarioMensual / p.diasBaseSalario;
  const dias = calcularDias_(entrada.fechaIngreso, entrada.fechaCorte, p);

  // Aguinaldo proporcional: 15 días (o el parámetro) por año, prorrateado por
  // los días efectivamente computables del ejercicio.
  const bruto = redondear2_(
    salarioDiario * p.diasAguinaldo * dias.diasComputables / dias.diasEjercicio
  );

  // Exención: 30 UMA diarias. El tope se compara contra el bruto.
  const limiteExento = redondear2_(p.umaDiaria * p.diasUmaExentos);
  const exento = Math.min(bruto, limiteExento);
  const gravable = Math.max(0, redondear2_(bruto - exento));

  const isr = calcularISR_(entrada.salarioMensual, gravable, p.tarifaIsr);

  // Cuota obrera atribuible al aguinaldo. Es una estimación de nómina:
  // el aguinaldo integra el SBC y el IMSS se determina mensualmente.
  const imss = calcularCuotasSeguridadSocial_(bruto, p);

  const neto = redondear2_(
    bruto - isr.isr - imss.total - entrada.otrasDeducciones
  );

  const advertencias = [];
  if (salarioDiario < p.salarioMinimoGeneral) {
    advertencias.push(
      'El salario diario (' + formatearMoneda_(salarioDiario) +
      ') está por debajo del salario mínimo general ' + p.anioFiscal + ' (' +
      formatearMoneda_(p.salarioMinimoGeneral) +
      '). Revisa el dato o la zona salarial.'
    );
  }
  if (entrada.fechaIngreso.anio < p.anioFiscal) {
    advertencias.push(
      'Para el ejercicio ' + p.anioFiscal + ' se computan los días a partir del 1 de enero. ' +
      'El aguinaldo de ejercicios anteriores no se incluye en este cálculo.'
    );
  }
  if (entrada.fechaCorte.iso !== p.anioFiscal + '-12-31') {
    advertencias.push(
      'La fecha de corte no es el 31 de diciembre: el aguinaldo se calculó de forma ' +
      'proporcional hasta esa fecha. Si se trata de un finiquito, revisa el tratamiento completo.'
    );
  }
  if (neto < 0) {
    advertencias.push(
      'Las deducciones superan el aguinaldo bruto; el neto resulta negativo. ' +
      'Revisa las otras deducciones o la retención aplicable.'
    );
  }

  const resultado = {
    entradas: {
      salarioMensual: entrada.salarioMensual,
      salarioDiario: salarioDiario,
      fechaIngreso: entrada.fechaIngreso.iso,
      fechaCorte: entrada.fechaCorte.iso,
      otrasDeducciones: entrada.otrasDeducciones
    },
    dias: {
      inicioComputable: dias.inicioComputable,
      diasComputables: dias.diasComputables,
      diasEjercicio: dias.diasEjercicio,
      diasAguinaldo: dias.diasAguinaldo,
      proporcion: dias.proporcion
    },
    importes: {
      bruto: bruto,
      limiteExento: limiteExento,
      exento: exento,
      gravable: gravable,
      isr: isr.isr,
      imss: imss.total,
      otrasDeducciones: entrada.otrasDeducciones,
      neto: neto
    },
    isr: {
      isrSinAguinaldo: isr.isrSin,
      baseConAguinaldo: isr.baseCon,
      isrConAguinaldo: isr.isrCon,
      isrAguinaldo: isr.isr,
      tramo: isr.tramo
    },
    imss: imss,
    parametros: {
      umaDiaria: p.umaDiaria,
      diasAguinaldo: p.diasAguinaldo,
      diasUmaExentos: p.diasUmaExentos,
      diasBaseSalario: p.diasBaseSalario,
      tasaImssObrera: p.tasaImssObrera,
      tasaImssExcedente: p.tasaImssExcedente,
      topeSbcUma: p.topeSbcUma,
      anioFiscal: p.anioFiscal,
      fechaActualizacion: p.fechaActualizacion
    },
    metodo: {
      isr: 'Art. 96 LISR: se suma la parte gravable al salario mensual, se aplica la tarifa mensual y se resta el ISR del salario sin aguinaldo.',
      imss: 'Cuota obrera estimada sobre el bruto: ' +
        formatearPorcentaje_(p.tasaImssObrera * 100, 3) + ' + ' +
        formatearPorcentaje_(p.tasaImssExcedente * 100, 2) +
        ' sobre el excedente de 3 UMA; tope de ' + p.topeSbcUma +
        ' UMA. No sustituye la cédula mensual del IMSS.'
    },
    advertencias: advertencias
  };

  resultado.formateado = formatearResultado_(resultado);

  // El comprobante no debe impedir que la interfaz muestre el resultado.
  try {
    guardarResultado_(ss, resultado);
  } catch (error) {
    resultado.advertencias.push(
      'El cálculo se realizó, pero no se pudo actualizar la hoja "Cálculo": ' +
      (error && error.message ? error.message : 'error desconocido')
    );
    resultado.formateado.advertencias = resultado.advertencias;
  }

  return { ok: true, resultado: resultado, advertencias: resultado.advertencias };
}

/* --------------------------------------------------------------------------
 * 1. ESTRUCTURA DE HOJAS Y PARÁMETROS
 * ------------------------------------------------------------------------ */

/**
 * Crea las hojas que falten y registra los rangos con nombre.
 * No sobrescribe hojas existentes: así se conservan los parámetros editados.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {Object}
 */
function crearEstructura_(ss) {
  let parametros = ss.getSheetByName(HOJA_PARAMETROS);
  if (!parametros) {
    parametros = crearHojaParametros_(ss);
  } else {
    validarHojaPropia_(parametros, 'PARÁMETROS DEL CÁLCULO');
  }

  let calculo = ss.getSheetByName(HOJA_CALCULO);
  if (!calculo) {
    calculo = crearHojaCalculo_(ss);
  } else {
    validarHojaPropia_(calculo, 'CÁLCULO DE AGUINALDO');
  }

  let notas = ss.getSheetByName(HOJA_NOTAS);
  if (!notas) {
    notas = crearHojaNotas_(ss);
  } else {
    validarHojaPropia_(notas, 'NOTAS, FUENTES Y SUPUESTOS');
  }

  configurarNombres_(ss);
  return {
    parametros: parametros,
    calculo: calculo,
    notas: notas
  };
}

/**
 * Evita borrar o leer una hoja ajena que casualmente tenga el mismo nombre.
 */
function validarHojaPropia_(hoja, prefijo) {
  const titulo = String(hoja.getRange('A1').getValue() || '');
  if (titulo.indexOf(prefijo) !== 0) {
    throw new Error(
      'La hoja "' + hoja.getName() + '" ya existe y no fue creada por esta calculadora. ' +
      'Renómbrala o elimínala antes de continuar.'
    );
  }
}

/**
 * Hoja de parámetros. Las filas y rangos con nombre son parte del contrato
 * con Code.gs; si se insertan filas, los nombres se ajustan automáticamente.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function crearHojaParametros_(ss) {
  const hoja = ss.insertSheet(HOJA_PARAMETROS);
  hoja.setTabColor('#0b4f6c');
  hoja.setHiddenGridlines(true);

  hoja.getRange('A1:D1')
    .merge()
    .setValue('PARÁMETROS DEL CÁLCULO — AGUINALDO 2026')
    .setBackground('#0b4f6c')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(14)
    .setVerticalAlignment('middle');
  hoja.setRowHeight(1, 34);

  hoja.getRange('A2:D2')
    .merge()
    .setValue('Edita únicamente la columna B. La lógica de Code.gs lee estos valores; no requiere cambios de código.')
    .setFontStyle('italic')
    .setFontColor('#5d7186')
    .setWrap(true);
  hoja.setRowHeight(2, 30);

  hoja.getRange('A3:D3')
    .setValues([['Parámetro', 'Valor 2026', 'Unidad', 'Fuente / nota']])
    .setBackground('#e8eef5')
    .setFontWeight('bold')
    .setFontColor('#12263a');

  const filas = [
    ['UMA diaria', 117.31, 'MXN', 'INEGI / DOF 09/01/2026. Vigente 01/02/2026–31/01/2027.'],
    ['UMA mensual', 3566.22, 'MXN', 'INEGI. Equivale a 30.4 UMA diarias.'],
    ['UMA anual', 42794.64, 'MXN', 'INEGI. Equivale a 12 UMA mensuales. No se usa para la exención del aguinaldo.'],
    ['Salario mínimo general diario', 315.04, 'MXN', 'CONASAMI / DOF 09/12/2025. Zona general.'],
    ['Salario mínimo frontera norte diario', 440.87, 'MXN', 'CONASAMI / DOF 09/12/2025. Zona Libre de la Frontera Norte.'],
    ['Días de aguinaldo por año', 15, 'días', 'LFT art. 87: mínimo de 15 días.'],
    ['Días de UMA exentos de ISR', 30, 'días', 'LISR art. 93, fr. XIV; el SAT aplica 30 UMA diarias.'],
    ['Días base para convertir salario mensual', 30, 'días', 'LSS art. 29 y práctica de nómina.'],
    ['Tasa obrera IMSS', 0.02375, '%', 'LSS: 0.25% + 0.375% + 0.625% + 1.125%.'],
    ['Tasa obrera IMSS sobre excedente de 3 UMA', 0.004, '%', 'LSS art. 106. Se aplica sobre el SBC que excede 3 UMA.'],
    ['Tope de SBC en UMA', 25, 'veces', 'LSS art. 28.'],
    ['Año fiscal', 2026, 'año', 'Ejercicio que se calcula.'],
    ['Fecha de actualización de parámetros', new Date(2026, 10, 9), 'fecha', 'Última revisión de valores y fuentes.']
  ];

  hoja.getRange(4, 1, filas.length, 4).setValues(filas);
  hoja.getRange(4, 1, filas.length, 1).setFontWeight('bold');
  hoja.getRange(4, 4, filas.length, 1).setWrap(true).setFontColor('#5d7186');
  hoja.setRowHeights(4, filas.length, 30);

  hoja.getRange('B4:B8').setNumberFormat(FORMATO_MONEDA);
  hoja.getRange('B9:B11').setNumberFormat('0');
  hoja.getRange('B12:B13').setNumberFormat('0.0000%');
  hoja.getRange('B14').setNumberFormat('0');
  hoja.getRange('B15').setNumberFormat('0');
  hoja.getRange('B16').setNumberFormat(FORMATO_FECHA);

  hoja.getRange('A18:D18')
    .merge()
    .setValue('TARIFA MENSUAL DEL ISR 2026')
    .setBackground('#0b4f6c')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(12);
  hoja.getRange('A19:D19')
    .merge()
    .setValue('Fuente: Anexo 8 de la RMF 2026, DOF 28/12/2025. Art. 96 LISR. Los importes están en pesos.')
    .setFontStyle('italic')
    .setFontColor('#5d7186');
  hoja.getRange('A20:D20')
    .setValues([['Límite inferior', 'Límite superior', 'Cuota fija', 'Tasa sobre el excedente']])
    .setBackground('#e8eef5')
    .setFontWeight('bold');

  const tarifa = [
    [0.01, 844.59, 0.00, 0.0192],
    [844.60, 7168.51, 16.22, 0.064],
    [7168.52, 12598.02, 420.95, 0.1088],
    [12598.03, 14644.64, 1011.68, 0.16],
    [14644.65, 17533.64, 1339.14, 0.1792],
    [17533.65, 35362.83, 1856.84, 0.2136],
    [35362.84, 55736.68, 5665.16, 0.2352],
    [55736.69, 106410.50, 10457.09, 0.30],
    [106410.51, 141880.66, 25659.23, 0.32],
    [141880.67, 425641.99, 37009.69, 0.34],
    [425642.00, 'En adelante', 133488.54, 0.35]
  ];
  hoja.getRange(21, 1, tarifa.length, 4).setValues(tarifa);
  hoja.getRange('A21:B31').setNumberFormat(FORMATO_MONEDA);
  hoja.getRange('C21:C31').setNumberFormat(FORMATO_MONEDA);
  hoja.getRange('D21:D31').setNumberFormat('0.0000%');

  hoja.getRange('A33:D34')
    .merge()
    .setValue(
      'Aclaración importante: la exención son 30 UMA DIARIAS (30 × $117.31 = $3,519.30). ' +
      'No son 30 veces la UMA anual. El artículo 93 de la LISR se refiere a 30 días de salario mínimo ' +
      'y el SAT revisa el límite con 30 UMA.'
    )
    .setBackground('#fff4d6')
    .setFontColor('#6b4b00')
    .setWrap(true)
    .setVerticalAlignment('middle');
  hoja.setRowHeight(33, 34);

  hoja.getRange('A36:D36')
    .merge()
    .setValue('Si actualizas un valor, cambia también la fecha de actualización y documenta la fuente en la hoja "Notas".')
    .setFontStyle('italic')
    .setFontColor('#5d7186')
    .setWrap(true);
  hoja.setRowHeight(36, 30);

  hoja.setColumnWidth(1, 360);
  hoja.setColumnWidth(2, 120);
  hoja.setColumnWidth(3, 100);
  hoja.setColumnWidth(4, 520);
  hoja.setFrozenRows(3);

  return hoja;
}

/**
 * Hoja donde se guarda el comprobante del último cálculo.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function crearHojaCalculo_(ss) {
  const hoja = ss.insertSheet(HOJA_CALCULO);
  hoja.setTabColor('#0a7f5a');
  hoja.setHiddenGridlines(true);
  hoja.getRange('A1:C1')
    .merge()
    .setValue('CÁLCULO DE AGUINALDO 2026')
    .setBackground('#0b4f6c')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(14)
    .setVerticalAlignment('middle');
  hoja.setRowHeight(1, 34);
  hoja.getRange('A2:C2')
    .merge()
    .setValue('Este comprobante se actualiza al presionar "Calcular aguinaldo" en la barra lateral. No edites las celdas de resultados.')
    .setFontStyle('italic')
    .setFontColor('#5d7186')
    .setWrap(true);
  hoja.setColumnWidth(1, 330);
  hoja.setColumnWidth(2, 190);
  hoja.setColumnWidth(3, 430);
  hoja.setFrozenRows(1);
  return hoja;
}

/**
 * Hoja de notas, fuentes, método y limitaciones.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function crearHojaNotas_(ss) {
  const hoja = ss.insertSheet(HOJA_NOTAS);
  hoja.setTabColor('#b45309');
  hoja.setHiddenGridlines(true);

  hoja.getRange('A1:G1')
    .merge()
    .setValue('NOTAS, FUENTES Y SUPUESTOS — AGUINALDO 2026')
    .setBackground('#0b4f6c')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(14)
    .setVerticalAlignment('middle');
  hoja.setRowHeight(1, 34);

  hoja.getRange('A2:G2')
    .merge()
    .setValue('Última revisión de parámetros: 09/11/2026. Los valores están en pesos mexicanos (MXN).')
    .setFontStyle('italic')
    .setFontColor('#5d7186');

  hoja.getRange('A3:G3')
    .merge()
    .setValue(
      'Aviso: esta hoja es informativa y no sustituye la asesoría de un contador público ni la determinación oficial de nómina. ' +
      'Antes de timbrar o pagar, confirma los parámetros vigentes y el tratamiento particular del trabajador.'
    )
    .setBackground('#fff4d6')
    .setFontColor('#6b4b00')
    .setWrap(true)
    .setVerticalAlignment('middle');
  hoja.setRowHeight(3, 42);

  hoja.getRange('A5:G5')
    .setValues([[
      'Categoría', 'Concepto', 'Valor 2026', 'Fuente', 'URL', 'Fecha de publicación / vigencia', 'Notas'
    ]])
    .setBackground('#e8eef5')
    .setFontWeight('bold')
    .setFontColor('#12263a');

  const lft = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf';
  const lisr = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf';
  const lss = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/LSS.pdf';
  const dofUma = 'https://dof.gob.mx/nota_detalle.php?codigo=5778072&fecha=09%2F01%2F2026';
  const satAnexo8 = 'https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo-8-RMF-2026_DOF-28122025.pdf';
  const conasami = 'https://www.gob.mx/conasami/es/articulos/se-publican-en-el-diario-oficial-de-la-federacion-los-salarios-minimos-vigentes-a-partir-del-1-de-enero-de-2026';
  const satSalarios = 'https://wwwmat.sat.gob.mx/consulta/02330/conoce-los-beneficios-del-regimen-de-salarios';

  const notas = [
    ['Laboral', 'Aguinaldo mínimo', '15 días de salario por año', 'LFT art. 87', lft, 'Vigente 2026', 'Prestación mínima; el contrato o la costumbre pueden otorgar un número mayor de días.'],
    ['Laboral', 'Días del ejercicio', '365', 'Calendario 2026', '', '2026', '2026 no es bisiesto. El denominador se obtiene del año fiscal, no de los días laborados.'],
    ['ISR', 'Exención del aguinaldo', '30 UMA diarias = $3,519.30', 'LISR art. 93, fr. XIV; SAT', lisr, 'Vigente 2026', 'Aclaración: son 30 × UMA diaria, NO 30 × UMA anual. Ver nota específica abajo.'],
    ['ISR', 'Criterio SAT sobre la exención', '30 UMA', 'SAT, beneficios del régimen de salarios', satSalarios, 'Consulta 2026', 'El SAT revisa que el aguinaldo exento no exceda 30 UMA.'],
    ['UMA', 'UMA diaria', '$117.31', 'INEGI / DOF 09/01/2026', dofUma, 'Vigente 01/02/2026–31/01/2027', 'Valor aplicable al cierre de 2026.'],
    ['UMA', 'UMA mensual', '$3,566.22', 'INEGI / DOF 09/01/2026', dofUma, 'Vigente 01/02/2026–31/01/2027', 'Equivale a 30.4 UMA diarias.'],
    ['UMA', 'UMA anual', '$42,794.64', 'INEGI / DOF 09/01/2026', dofUma, 'Vigente 01/02/2026–31/01/2027', 'Equivale a 12 UMA mensuales; no se usa para la exención del aguinaldo.'],
    ['Salarios', 'Salario mínimo general diario', '$315.04', 'CONASAMI / DOF 09/12/2025', conasami, 'Vigente 01/01/2026', 'Zona del Salario Mínimo General.'],
    ['Salarios', 'Salario mínimo frontera norte diario', '$440.87', 'CONASAMI / DOF 09/12/2025', conasami, 'Vigente 01/01/2026', 'Zona Libre de la Frontera Norte.'],
    ['ISR', 'Tarifa mensual del ISR 2026', '11 tramos, 1.92% a 35%', 'SAT Anexo 8 RMF 2026 / DOF 28/12/2025', satAnexo8, 'Publicada 28/12/2025', 'Art. 96 LISR. La tabla completa está en la hoja "Parámetros".'],
    ['IMSS', 'Cuota obrera base', '2.375% del SBC', 'LSS arts. 25, 106, 107, 147 y 168', lss, 'Vigente 2026', 'Incluye 0.25% (dinero), 0.375% (pensionados), 0.625% (invalidez y vida) y 1.125% (cesantía y vejez).'],
    ['IMSS', 'Cuota obrera sobre excedente de 3 UMA', '0.40%', 'LSS art. 106', lss, 'Vigente 2026', 'Se aplica sobre el SBC que excede 3 UMA.'],
    ['IMSS', 'Tope del SBC', '25 UMA diarias', 'LSS art. 28', lss, 'Vigente 2026', '25 × $117.31 = $2,932.75 diarios.'],
    ['ISR', 'Método de retención usado', 'Art. 96 LISR', 'LISR art. 96', lisr, 'Vigente 2026', 'Se suma la parte gravable al salario mensual, se aplica la tarifa y se resta el ISR del salario sin aguinaldo.'],
    ['ISR', 'Subsidio al empleo', 'No aplicado', 'Decreto DOF 31/12/2025', '', 'Vigente 2026', 'Simplificación: el subsidio corresponde al salario ordinario. No se aplica en este cálculo.'],
    ['ISR', 'ISR opcional del art. 174 RLISR', 'No implementado', 'Reglamento de la LISR art. 174', '', 'Vigente 2026', 'Existe un procedimiento opcional de retención mensualizada que puede reducir la retención. No se incluye para mantener el cálculo simple.'],
    ['IMSS', 'Base de la cuota del aguinaldo', 'Bruto, con tope de 25 UMA', 'LSS art. 27', lss, 'Vigente 2026', 'Estimación: el aguinaldo integra el SBC. La cuota obrera se atribuye al bruto; no es la cédula mensual del IMSS.'],
    ['Deducciones', 'Otras deducciones', 'Capturadas por el usuario', 'N/A', '', '', 'Préstamos, pensión alimenticia, etc. No modifican el ISR ni el IMSS en este modelo.'],
    ['Cálculo', 'Redondeo', '2 decimales', 'N/A', '', '', 'Se redondea cada concepto monetario al final. Las diferencias de centavos son posibles.'],
    ['Legal', 'Alcance', 'Informativo', 'N/A', '', '', 'No sustituye asesoría fiscal, laboral o de seguridad social. No contempla salario variable, comisiones, PTU, prima vacacional ni otros ingresos.']
  ];

  hoja.getRange(6, 1, notas.length, 7).setValues(notas);
  hoja.getRange(6, 1, notas.length, 7)
    .setWrap(true)
    .setVerticalAlignment('top');
  hoja.getRange(6, 1, notas.length, 1).setFontWeight('bold');
  hoja.getRange(6, 6, notas.length, 1).setHorizontalAlignment('center');
  hoja.setRowHeights(6, notas.length, 54);

  // Convertir las URL en enlaces clicables.
  for (let i = 0; i < notas.length; i++) {
    const url = notas[i][4];
    if (!url) continue;
    const celda = hoja.getRange(6 + i, 5);
    const rich = SpreadsheetApp.newRichTextValue()
      .setText(url)
      .setLinkUrl(url)
      .build();
    celda.setRichTextValue(rich);
    celda.setFontColor('#0b5394');
  }

  let fila = 6 + notas.length + 1;

  escribirBloqueNotas_(hoja, fila, 'ACLARACIÓN SOBRE LA EXENCIÓN (30 UMA)');
  fila += 1;
  hoja.getRange(fila, 1, 1, 7)
    .merge()
    .setValue(
      'La exención del aguinaldo es de 30 UMA DIARIAS: 30 × $117.31 = $3,519.30. ' +
      'No son 30 veces la UMA anual. Si se multiplicara la UMA anual por 30, el exento sería $1,283,839.20, ' +
      'muy superior al criterio legal y al que revisa el SAT. El artículo 93 de la LISR se refiere a 30 días ' +
      'de salario mínimo y el SAT opera el límite con 30 UMA.'
    )
    .setWrap(true)
    .setBackground('#fff4d6')
    .setFontColor('#6b4b00')
    .setVerticalAlignment('top');
  hoja.setRowHeight(fila, 60);
  fila += 2;

  escribirBloqueNotas_(hoja, fila, 'MÉTODO Y SUPUESTOS');
  fila += 1;
  const supuestos = [
    'Salario fijo mensual. Se convierte a diario dividiendo entre 30 (parámetro editable).',
    'Días computables inclusivos: se cuentan tanto la fecha de ingreso como la fecha de corte. Si el ingreso es anterior al año fiscal, se computa desde el 1 de enero.',
    'Aguinaldo proporcional: 15 días × días computables ÷ días del ejercicio. No se suman aguinaldos de años anteriores.',
    'ISR: método general del artículo 96 de la LISR. Se calcula el ISR del salario mensual, el ISR del salario más la parte gravable y se atribuye la diferencia al aguinaldo. No se aplica subsidio al empleo.',
    'IMSS: cuota obrera estimada sobre el bruto del aguinaldo, con tope de 25 UMA y 0.40% adicional sobre el excedente de 3 UMA. No se incluyen cuotas patronales, INFONAVIT, SAR ni riesgos de trabajo.',
    'Otras deducciones: se restan del bruto después de ISR e IMSS; no se recalcula su efecto fiscal.',
    'Redondeo a dos decimales por concepto; el neto se obtiene de los importes ya redondeados.'
  ];
  for (const texto of supuestos) {
    hoja.getRange(fila, 1, 1, 7).merge().setValue('• ' + texto).setWrap(true);
    hoja.setRowHeight(fila, 32);
    fila += 1;
  }
  fila += 1;

  escribirBloqueNotas_(hoja, fila, 'LIMITACIONES');
  fila += 1;
  const limitaciones = [
    'No sustituye asesoría fiscal, laboral ni de seguridad social.',
    'No contempla salario variable, comisiones, destajo, horas extra, PTU, prima vacacional, bonos ni otros ingresos.',
    'No modela faltas injustificadas, incapacidades, licencias, maternidad, riesgos de trabajo ni otros periodos que puedan alterar los días computables.',
    'No calcula finiquitos, liquidaciones, indemnizaciones ni prima de antigüedad.',
    'No incluye ISR anual, subsidio al empleo, ajuste anual, retenciones de ejercicios anteriores ni el procedimiento opcional del artículo 174 del Reglamento de la LISR.',
    'La cuota obrera del IMSS es una atribución estimada. El aguinaldo integra el salario base de cotización y el IMSS determina las cuotas mensualmente; confirma el cálculo con la cédula oficial.',
    'No incluye cuotas patronales, INFONAVIT, SAR, riesgo de trabajo, impuesto sobre nómina estatal ni otras contribuciones.',
    'La UMA de 2026 entró en vigor el 1 de febrero de 2026. Para pagos de enero de 2026 aplicaría la UMA anterior; este modelo está pensado para el cierre del ejercicio 2026.'
  ];
  for (const texto of limitaciones) {
    hoja.getRange(fila, 1, 1, 7).merge().setValue('• ' + texto).setWrap(true);
    hoja.setRowHeight(fila, 32);
    fila += 1;
  }
  fila += 1;

  escribirBloqueNotas_(hoja, fila, 'CÓMO ACTUALIZAR PARA OTRO EJERCICIO');
  fila += 1;
  const actualizacion = [
    'Actualiza la UMA diaria, mensual y anual en la hoja "Parámetros".',
    'Actualiza la tarifa mensual del ISR con la tabla publicada en el Anexo 8 de la RMF del año correspondiente.',
    'Actualiza el salario mínimo general y de la frontera norte si los usas como referencia.',
    'Cambia el año fiscal y la fecha de actualización.',
    'Revisa la cuota obrera del IMSS y el tope de 25 UMA; pueden cambiar por reformas.',
    'Documenta la nueva fuente y fecha en esta hoja.'
  ];
  for (const texto of actualizacion) {
    hoja.getRange(fila, 1, 1, 7).merge().setValue('• ' + texto).setWrap(true);
    hoja.setRowHeight(fila, 28);
    fila += 1;
  }

  hoja.setColumnWidth(1, 100);
  hoja.setColumnWidth(2, 250);
  hoja.setColumnWidth(3, 220);
  hoja.setColumnWidth(4, 260);
  hoja.setColumnWidth(5, 330);
  hoja.setColumnWidth(6, 150);
  hoja.setColumnWidth(7, 420);
  hoja.setFrozenRows(5);

  return hoja;
}

/**
 * Escribe un encabezado de sección en la hoja Notas.
 */
function escribirBloqueNotas_(hoja, fila, titulo) {
  hoja.getRange(fila, 1, 1, 7)
    .merge()
    .setValue(titulo)
    .setBackground('#e8eef5')
    .setFontWeight('bold')
    .setFontColor('#0b4f6c');
}

/**
 * Registra los rangos con nombre que usa Code.gs. Si ya existen y siguen en
 * la hoja Parámetros, los conserva para respetar los ajustes de filas que hace
 * Google Sheets.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function configurarNombres_(ss) {
  const hoja = ss.getSheetByName(HOJA_PARAMETROS);
  if (!hoja) return;

  const definiciones = [
    ['UMA_DIARIA', 'B4'],
    ['UMA_MENSUAL', 'B5'],
    ['UMA_ANUAL', 'B6'],
    ['SM_GENERAL', 'B7'],
    ['SM_FRONTERA', 'B8'],
    ['DIAS_AGUINALDO', 'B9'],
    ['DIAS_UMA_EXENTOS', 'B10'],
    ['DIAS_BASE_SALARIO', 'B11'],
    ['TASA_IMSS_OBRERA', 'B12'],
    ['TASA_IMSS_EXCEDENTE', 'B13'],
    ['TOPE_SBC_UMA', 'B14'],
    ['ANIO_FISCAL', 'B15'],
    ['FECHA_ACTUALIZACION', 'B16'],
    ['TARIFA_ISR', 'A21:D31']
  ];

  for (const [nombre, direccion] of definiciones) {
    definirNombre_(ss, nombre, hoja.getRange(direccion));
  }
}

/**
 * Crea o actualiza un rango con nombre sin duplicarlo.
 */
function definirNombre_(ss, nombre, rango) {
  const existentes = ss.getNamedRanges().filter(function (nr) {
    return nr.getName() === nombre;
  });

  if (existentes.length === 0) {
    ss.setNamedRange(nombre, rango);
    return;
  }

  // Si el nombre ya existe y sigue apuntando a la hoja Parámetros, se conserva.
  // Así, si el usuario inserta filas, Google Sheets ajusta el rango y no lo
  // devolvemos a una dirección fija. Solo se reapunta si está roto o en otra hoja.
  try {
    const rangoActual = existentes[0].getRange();
    if (!rangoActual || rangoActual.getSheet().getName() !== HOJA_PARAMETROS) {
      existentes[0].setRange(rango);
    }
  } catch (error) {
    existentes[0].setRange(rango);
  }

  for (let i = 1; i < existentes.length; i++) {
    existentes[i].remove();
  }
}

/**
 * Lee y valida todos los parámetros de la hoja.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {Object}
 */
function obtenerParametros_(ss) {
  const umaDiaria = leerNumeroParametro_(ss, 'UMA_DIARIA', 'UMA diaria');
  const umaMensual = leerNumeroParametro_(ss, 'UMA_MENSUAL', 'UMA mensual');
  const umaAnual = leerNumeroParametro_(ss, 'UMA_ANUAL', 'UMA anual');
  const salarioMinimoGeneral = leerNumeroParametro_(ss, 'SM_GENERAL', 'salario mínimo general');
  const salarioMinimoFrontera = leerNumeroParametro_(ss, 'SM_FRONTERA', 'salario mínimo frontera norte');
  const diasAguinaldo = leerNumeroParametro_(ss, 'DIAS_AGUINALDO', 'días de aguinaldo');
  const diasUmaExentos = leerNumeroParametro_(ss, 'DIAS_UMA_EXENTOS', 'días de UMA exentos');
  const diasBaseSalario = leerNumeroParametro_(ss, 'DIAS_BASE_SALARIO', 'días base del salario');
  const tasaImssObrera = leerNumeroParametro_(ss, 'TASA_IMSS_OBRERA', 'tasa obrera del IMSS');
  const tasaImssExcedente = leerNumeroParametro_(ss, 'TASA_IMSS_EXCEDENTE', 'tasa del IMSS sobre excedente');
  const topeSbcUma = leerNumeroParametro_(ss, 'TOPE_SBC_UMA', 'tope del SBC en UMA');
  const anioFiscalDecimal = leerNumeroParametro_(ss, 'ANIO_FISCAL', 'año fiscal');
  const anioFiscal = Math.round(anioFiscalDecimal);

  if (anioFiscal < 2020 || anioFiscal > 2100) {
    throw new Error('El año fiscal de la hoja "Parámetros" debe estar entre 2020 y 2100.');
  }
  if (Math.abs(anioFiscalDecimal - anioFiscal) > 0.0001) {
    throw new Error('El año fiscal debe ser un número entero.');
  }
  if (tasaImssObrera >= 1 || tasaImssExcedente >= 1) {
    throw new Error(
      'Las tasas del IMSS deben capturarse como proporción (2.375% = 0.02375), no como 2.375.'
    );
  }

  const tarifaIsr = leerTarifaIsr_(ss);

  const rangoFecha = ss.getRangeByName('FECHA_ACTUALIZACION');
  if (!rangoFecha) {
    throw new Error('Falta el parámetro FECHA_ACTUALIZACION. Ejecuta "Instalar / reparar hojas".');
  }
  const valorFecha = rangoFecha.getValue();
  const fechaActualizacion = valorFecha instanceof Date
    ? Utilities.formatDate(valorFecha, Session.getScriptTimeZone(), FORMATO_FECHA)
    : String(valorFecha || '');

  return {
    umaDiaria: umaDiaria,
    umaMensual: umaMensual,
    umaAnual: umaAnual,
    salarioMinimoGeneral: salarioMinimoGeneral,
    salarioMinimoFrontera: salarioMinimoFrontera,
    diasAguinaldo: diasAguinaldo,
    diasUmaExentos: diasUmaExentos,
    diasBaseSalario: diasBaseSalario,
    tasaImssObrera: tasaImssObrera,
    tasaImssExcedente: tasaImssExcedente,
    topeSbcUma: topeSbcUma,
    anioFiscal: anioFiscal,
    fechaActualizacion: fechaActualizacion,
    tarifaIsr: tarifaIsr
  };
}

/**
 * Lee un parámetro numérico positivo por nombre.
 */
function leerNumeroParametro_(ss, nombre, etiqueta) {
  const rango = ss.getRangeByName(nombre);
  if (!rango) {
    throw new Error(
      'Falta el parámetro "' + etiqueta + '" (' + nombre +
      '). Ejecuta "Aguinaldo 2026" > "Instalar / reparar hojas".'
    );
  }

  const valor = rango.getValue();
  const numero = typeof valor === 'number'
    ? valor
    : Number(String(valor).replace(/\s/g, '').replace(/,/g, ''));

  if (!isFinite(numero) || numero <= 0) {
    throw new Error(
      'El parámetro "' + etiqueta + '" debe ser un número mayor a cero. Revisa la hoja "Parámetros".'
    );
  }
  return numero;
}

/**
 * Lee la tarifa mensual del ISR. Acepta la última fila con "En adelante" o vacía
 * en el límite superior.
 */
function leerTarifaIsr_(ss) {
  const rango = ss.getRangeByName('TARIFA_ISR');
  if (!rango || rango.getNumColumns() < 4) {
    throw new Error('Falta la tabla TARIFA_ISR o no tiene cuatro columnas. Ejecuta "Instalar / reparar hojas".');
  }

  const valores = rango.getValues();
  const tarifa = [];

  for (const fila of valores) {
    const vacia = fila.every(function (v) { return v === '' || v === null; });
    if (vacia) continue;

    const limiteInferior = Number(fila[0]);
    const cuotaFija = Number(fila[2]);
    let tasa = Number(fila[3]);

    if (!isFinite(limiteInferior) || !isFinite(cuotaFija) || !isFinite(tasa)) {
      throw new Error('La tabla TARIFA_ISR contiene valores no numéricos. Revisa la hoja "Parámetros".');
    }

    // Si el usuario capturó 21.36 en lugar de 0.2136, se normaliza.
    if (tasa > 1 && tasa <= 100) tasa = tasa / 100;
    if (tasa < 0 || tasa > 1) {
      throw new Error('La tasa de la tabla TARIFA_ISR debe estar entre 0% y 100%.');
    }

    const limiteSuperiorTexto = String(fila[1] || '').trim();
    const limiteSuperior = (!limiteSuperiorTexto || /en\s+adelante/i.test(limiteSuperiorTexto))
      ? null
      : Number(fila[1]);

    if (limiteSuperior !== null && !isFinite(limiteSuperior)) {
      throw new Error('El límite superior de la tabla TARIFA_ISR no es válido.');
    }

    tarifa.push({
      limiteInferior: limiteInferior,
      limiteSuperior: limiteSuperior,
      cuotaFija: cuotaFija,
      tasa: tasa
    });
  }

  if (tarifa.length < 2) {
    throw new Error('La tabla TARIFA_ISR debe tener al menos dos tramos.');
  }

  for (let i = 0; i < tarifa.length; i++) {
    const actual = tarifa[i];
    if (actual.limiteSuperior !== null && actual.limiteSuperior < actual.limiteInferior) {
      throw new Error('La tabla TARIFA_ISR tiene un límite superior menor que el inferior.');
    }
    if (i > 0) {
      const anterior = tarifa[i - 1];
      if (anterior.limiteSuperior === null) {
        throw new Error('La tabla TARIFA_ISR no debe tener tramos después de "En adelante".');
      }
      if (actual.limiteInferior <= anterior.limiteSuperior) {
        throw new Error('Los tramos de la tabla TARIFA_ISR se traslapan o no están ordenados.');
      }
    }
  }

  if (tarifa[tarifa.length - 1].limiteSuperior !== null) {
    throw new Error('El último tramo de TARIFA_ISR debe tener "En adelante" o un límite superior vacío.');
  }

  return tarifa;
}

/* --------------------------------------------------------------------------
 * 2. VALIDACIÓN Y FECHAS
 * ------------------------------------------------------------------------ */

/**
 * Valida y normaliza los datos del formulario.
 */
function validarEntrada_(datos, params) {
  const errores = [];
  const entrada = datos && typeof datos === 'object' ? datos : {};

  const salarioMensual = aNumero_(entrada.salarioMensual);
  if (!isFinite(salarioMensual) || salarioMensual <= 0) {
    errores.push({
      campo: 'salarioMensual',
      mensaje: 'Captura un salario mensual mayor a cero.'
    });
  }

  const fechaIngreso = parseFechaISO_(entrada.fechaIngreso);
  if (!fechaIngreso) {
    errores.push({
      campo: 'fechaIngreso',
      mensaje: 'Selecciona una fecha de ingreso válida (dd/mm/aaaa).'
    });
  }

  const fechaCorte = parseFechaISO_(entrada.fechaCorte);
  if (!fechaCorte) {
    errores.push({
      campo: 'fechaCorte',
      mensaje: 'Selecciona una fecha de corte válida (dd/mm/aaaa).'
    });
  } else if (fechaCorte.anio !== params.anioFiscal) {
    errores.push({
      campo: 'fechaCorte',
      mensaje: 'Este modelo usa parámetros de ' + params.anioFiscal +
        '. La fecha de corte debe estar dentro de ' + params.anioFiscal + '.'
    });
  }

  let otrasDeducciones = entrada.otrasDeducciones;
  if (otrasDeducciones === '' || otrasDeducciones === null || otrasDeducciones === undefined) {
    otrasDeducciones = 0;
  } else {
    otrasDeducciones = aNumero_(otrasDeducciones);
  }
  if (!isFinite(otrasDeducciones) || otrasDeducciones < 0) {
    errores.push({
      campo: 'otrasDeducciones',
      mensaje: 'Las otras deducciones deben ser un número mayor o igual a cero.'
    });
  }

  if (
    fechaIngreso &&
    fechaCorte &&
    fechaCorte.anio === params.anioFiscal &&
    fechaCorte.utc < fechaIngreso.utc
  ) {
    errores.push({
      campo: 'fechaCorte',
      mensaje: 'La fecha de corte no puede ser anterior a la fecha de ingreso.'
    });
  }

  if (errores.length > 0) {
    return { ok: false, errores: errores };
  }

  return {
    ok: true,
    datos: {
      salarioMensual: salarioMensual,
      fechaIngreso: fechaIngreso,
      fechaCorte: fechaCorte,
      otrasDeducciones: otrasDeducciones
    }
  };
}

/**
 * Convierte un valor a número aceptando comas de miles.
 */
function aNumero_(valor) {
  if (typeof valor === 'number') return valor;
  if (valor === null || valor === undefined) return NaN;
  return Number(String(valor).replace(/\s/g, '').replace(/,/g, ''));
}

/**
 * Parsea una fecha ISO (YYYY-MM-DD) a componentes y a un instante UTC.
 * Se usa UTC para que la aritmética de días no dependa del horario de verano.
 *
 * @param {string} valor
 * @return {Object|null}
 */
function parseFechaISO_(valor) {
  if (typeof valor !== 'string') return null;
  const texto = valor.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!match) return null;

  const anio = Number(match[1]);
  const mes = Number(match[2]);
  const dia = Number(match[3]);
  if (anio < 1900 || anio > 2100 || mes < 1 || mes > 12 || dia < 1 || dia > 31) {
    return null;
  }

  const utc = Date.UTC(anio, mes - 1, dia);
  const fecha = new Date(utc);
  if (
    fecha.getUTCFullYear() !== anio ||
    fecha.getUTCMonth() !== mes - 1 ||
    fecha.getUTCDate() !== dia
  ) {
    return null;
  }

  return {
    anio: anio,
    mes: mes,
    dia: dia,
    iso: texto,
    utc: utc
  };
}

/**
 * Convierte componentes de fecha a ISO.
 */
function fechaAISO_(anio, mes, dia) {
  return String(anio) + '-' +
    String(mes).padStart(2, '0') + '-' +
    String(dia).padStart(2, '0');
}

/**
 * Formatea una fecha ISO como dd/mm/aaaa.
 */
function formatearFechaISO_(iso) {
  const fecha = parseFechaISO_(iso);
  if (!fecha) return '';
  return String(fecha.dia).padStart(2, '0') + '/' +
    String(fecha.mes).padStart(2, '0') + '/' +
    fecha.anio;
}

/**
 * Convierte una fecha ISO a un objeto Date local al mediodía, apto para
 * escribir en la hoja con formato dd/mm/aaaa.
 */
function fechaLocalDesdeISO_(iso) {
  const fecha = parseFechaISO_(iso);
  if (!fecha) return '';
  return new Date(fecha.anio, fecha.mes - 1, fecha.dia, 12, 0, 0);
}

/**
 * Indica si un año es bisiesto.
 */
function esBisiesto_(anio) {
  return (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0;
}

/* --------------------------------------------------------------------------
 * 3. CÁLCULOS
 * ------------------------------------------------------------------------ */

/**
 * Calcula los días computables y la proporción del aguinaldo.
 *
 * El conteo es inclusivo: si ingresa el 1 de enero y el corte es el 31 de
 * diciembre, son 365 días (2026 no bisiesto). Si ingresó antes del ejercicio,
 * se computa desde el 1 de enero del año fiscal.
 */
function calcularDias_(fechaIngreso, fechaCorte, params) {
  const inicioEjercicioUtc = Date.UTC(params.anioFiscal, 0, 1);
  const finEjercicioUtc = Date.UTC(params.anioFiscal, 11, 31);
  const diasEjercicio = esBisiesto_(params.anioFiscal) ? 366 : 365;

  const inicioUtc = Math.max(fechaIngreso.utc, inicioEjercicioUtc);
  const finUtc = Math.min(fechaCorte.utc, finEjercicioUtc);

  if (finUtc < inicioUtc) {
    throw new Error('La fecha de corte no deja días computables en el ejercicio fiscal.');
  }

  const diasComputables = Math.round((finUtc - inicioUtc) / MS_DIA) + 1;
  const diasAguinaldo = params.diasAguinaldo * diasComputables / diasEjercicio;

  let inicioAnio = params.anioFiscal;
  let inicioMes = 1;
  let inicioDia = 1;
  if (fechaIngreso.utc >= inicioEjercicioUtc && fechaIngreso.utc <= finEjercicioUtc) {
    inicioAnio = fechaIngreso.anio;
    inicioMes = fechaIngreso.mes;
    inicioDia = fechaIngreso.dia;
  }

  return {
    inicioComputable: fechaAISO_(inicioAnio, inicioMes, inicioDia),
    diasComputables: diasComputables,
    diasEjercicio: diasEjercicio,
    diasAguinaldo: diasAguinaldo,
    proporcion: diasComputables / diasEjercicio
  };
}

/**
 * Aplica la tarifa mensual del ISR a una base.
 * Fórmula: cuota fija + (base - límite inferior) × tasa.
 *
 * @param {number} base
 * @param {Array<Object>} tarifa
 * @return {number}
 */
function calcularISRTarifa_(base, tarifa) {
  if (!isFinite(base) || base <= 0) return 0;
  if (base < tarifa[0].limiteInferior) return 0;

  const tramo = obtenerTramo_(base, tarifa);
  if (!tramo) {
    throw new Error('La base de ISR no se pudo ubicar en la tarifa. Revisa la tabla de la hoja "Parámetros".');
  }

  const impuesto = tramo.cuotaFija + (base - tramo.limiteInferior) * tramo.tasa;
  return redondear2_(Math.max(0, impuesto));
}

/**
 * Devuelve el tramo de la tarifa que corresponde a la base.
 */
function obtenerTramo_(base, tarifa) {
  if (!isFinite(base) || base <= 0) return tarifa[0];
  if (base < tarifa[0].limiteInferior) return tarifa[0];

  // Se usa el límite inferior como criterio. Los tramos publicados tienen
  // fronteras con dos decimales (por ejemplo 844.59 / 844.60); buscar por
  // rango exacto dejaría fuera bases con fracciones de centavo.
  let tramo = tarifa[0];
  for (const actual of tarifa) {
    if (base >= actual.limiteInferior) {
      tramo = actual;
    } else {
      break;
    }
  }
  return tramo;
}

/**
 * ISR atribuible al aguinaldo por el método general del artículo 96 de la LISR.
 *
 * No calcula el ISR total del mes: aísla la diferencia que produce la parte
 * gravable del aguinaldo al sumarse al salario mensual. El resultado de la
 * interfaz es esa diferencia.
 */
function calcularISR_(salarioMensual, parteGravable, tarifa) {
  const isrSin = calcularISRTarifa_(salarioMensual, tarifa);
  const baseCon = salarioMensual + parteGravable;
  const isrCon = calcularISRTarifa_(baseCon, tarifa);
  const isr = Math.max(0, redondear2_(isrCon - isrSin));
  const tramo = obtenerTramo_(baseCon, tarifa);

  return {
    isrSin: isrSin,
    baseCon: baseCon,
    isrCon: isrCon,
    isr: isr,
    tramo: tramo
  };
}

/**
 * Cuota obrera del IMSS atribuible al aguinaldo.
 *
 * El aguinaldo integra el SBC, por lo que la determinación exacta se hace en
 * la cédula mensual del IMSS. Aquí se calcula una atribución estimada sobre el
 * bruto del aguinaldo, con el tope de 25 UMA y la cuota adicional de 0.40%
 * sobre el excedente de 3 UMA.
 */
function calcularCuotasSeguridadSocial_(bruto, params) {
  const tope = params.umaDiaria * params.diasBaseSalario * params.topeSbcUma;
  const base = Math.min(Math.max(0, bruto), tope);
  const umbralTresUma = params.umaDiaria * params.diasBaseSalario * 3;

  const cuotaBase = base * params.tasaImssObrera;
  const excedente = Math.max(0, base - umbralTresUma);
  const cuotaExcedente = excedente * params.tasaImssExcedente;
  const total = redondear2_(cuotaBase + cuotaExcedente);

  return {
    base: redondear2_(base),
    tope: redondear2_(tope),
    umbralTresUma: redondear2_(umbralTresUma),
    cuotaBase: redondear2_(cuotaBase),
    excedente: redondear2_(excedente),
    cuotaExcedente: redondear2_(cuotaExcedente),
    total: total,
    tasaBase: params.tasaImssObrera,
    tasaExcedente: params.tasaImssExcedente
  };
}

/* --------------------------------------------------------------------------
 * 4. FORMATO DE SALIDA
 * ------------------------------------------------------------------------ */

/**
 * Agrega cadenas formateadas al resultado para que la interfaz y la hoja
 * muestren el mismo formato mexicano.
 */
function formatearResultado_(r) {
  const tramo = r.isr.tramo;
  const formulaDias = formatearNumero_(r.parametros.diasAguinaldo, 0) +
    ' × ' + formatearNumero_(r.dias.diasComputables, 0) +
    ' ÷ ' + formatearNumero_(r.dias.diasEjercicio, 0) +
    ' = ' + formatearNumero_(r.dias.diasAguinaldo, 4) + ' días';

  return {
    salarioMensual: formatearMoneda_(r.entradas.salarioMensual),
    salarioDiario: formatearMoneda_(r.entradas.salarioDiario),
    fechaIngreso: formatearFechaISO_(r.entradas.fechaIngreso),
    fechaCorte: formatearFechaISO_(r.entradas.fechaCorte),
    inicioComputable: formatearFechaISO_(r.dias.inicioComputable),
    diasComputables: formatearNumero_(r.dias.diasComputables, 0),
    diasEjercicio: formatearNumero_(r.dias.diasEjercicio, 0),
    diasAguinaldo: formatearNumero_(r.dias.diasAguinaldo, 4),
    proporcion: formatearPorcentaje_(r.dias.proporcion * 100, 4),
    formulaDias: formulaDias,
    bruto: formatearMoneda_(r.importes.bruto),
    limiteExento: formatearMoneda_(r.importes.limiteExento),
    exento: formatearMoneda_(r.importes.exento),
    gravable: formatearMoneda_(r.importes.gravable),
    isr: formatearMoneda_(r.importes.isr),
    imss: formatearMoneda_(r.importes.imss),
    otrasDeducciones: formatearMoneda_(r.importes.otrasDeducciones),
    neto: formatearMoneda_(r.importes.neto),
    isrSinAguinaldo: formatearMoneda_(r.isr.isrSinAguinaldo),
    baseConAguinaldo: formatearMoneda_(r.isr.baseConAguinaldo),
    isrConAguinaldo: formatearMoneda_(r.isr.isrConAguinaldo),
    isrAguinaldo: formatearMoneda_(r.isr.isrAguinaldo),
    tramoIsr: 'Límite inferior ' + formatearMoneda_(tramo.limiteInferior) +
      '; cuota fija ' + formatearMoneda_(tramo.cuotaFija) +
      '; ' + formatearPorcentaje_(tramo.tasa * 100, 2) + ' sobre el excedente.',
    imssBase: formatearMoneda_(r.imss.base),
    imssTope: formatearMoneda_(r.imss.tope),
    imssUmbral: formatearMoneda_(r.imss.umbralTresUma),
    imssCuotaBase: formatearMoneda_(r.imss.cuotaBase),
    imssExcedente: formatearMoneda_(r.imss.excedente),
    imssCuotaExcedente: formatearMoneda_(r.imss.cuotaExcedente),
    imssTotal: formatearMoneda_(r.imss.total),
    tasaImssObrera: formatearPorcentaje_(r.imss.tasaBase * 100, 3),
    tasaImssExcedente: formatearPorcentaje_(r.imss.tasaExcedente * 100, 2),
    umaDiaria: formatearMoneda_(r.parametros.umaDiaria),
    diasUmaExentos: formatearNumero_(r.parametros.diasUmaExentos, 0),
    actualizacion: r.parametros.fechaActualizacion,
    metodoIsr: r.metodo.isr,
    metodoImss: r.metodo.imss,
    advertencias: r.advertencias
  };
}

/**
 * Formatea un número como moneda mexicana: $1,234.56.
 */
function formatearMoneda_(valor) {
  const numero = Number(valor);
  if (!isFinite(numero)) return '';
  const negativo = numero < 0;
  const texto = formatearNumero_(Math.abs(numero), 2);
  return (negativo ? '-$' : '$') + texto;
}

/**
 * Formatea un número con separador de miles y decimales fijos.
 */
function formatearNumero_(valor, decimales) {
  const numero = Number(valor);
  if (!isFinite(numero)) return '';
  const lugares = typeof decimales === 'number' ? decimales : 2;
  const partes = numero.toFixed(lugares).split('.');
  const enteros = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return partes.length > 1 ? enteros + '.' + partes[1] : enteros;
}

/**
 * Formatea un porcentaje ya expresado en puntos (ej. 21.36 -> 21.36%).
 */
function formatearPorcentaje_(valor, decimales) {
  return formatearNumero_(valor, decimales) + '%';
}

/**
 * Redondea a dos decimales.
 */
function redondear2_(valor) {
  const numero = Number(valor);
  if (!isFinite(numero)) return 0;
  return Math.round((numero + Number.EPSILON) * 100) / 100;
}

/* --------------------------------------------------------------------------
 * 5. COMPROBANTE EN LA HOJA DE CÁLCULO
 * ------------------------------------------------------------------------ */

/**
 * Escribe el último cálculo en la hoja "Cálculo". Usa un candado para evitar
 * escrituras simultáneas de dos usuarios.
 */
function guardarResultado_(ss, r) {
  const hoja = ss.getSheetByName(HOJA_CALCULO) || crearHojaCalculo_(ss);

  const lock = LockService.getDocumentLock();
  let bloqueado = false;

  try {
    bloqueado = lock.tryLock(10000);
    if (!bloqueado) {
      throw new Error('la hoja está ocupada por otro cálculo; intenta de nuevo.');
    }

    validarHojaPropia_(hoja, 'CÁLCULO DE AGUINALDO');
    hoja.clear();
    // Se separan las combinaciones antes de volver a combinar; así el
    // comprobante se puede regenerar muchas veces sin errores de merge.
    hoja.getRange(1, 1, hoja.getMaxRows(), 3).breakApart();
    hoja.setHiddenGridlines(true);
    hoja.setColumnWidth(1, 330);
    hoja.setColumnWidth(2, 190);
    hoja.setColumnWidth(3, 430);

    hoja.getRange('A1:C1')
      .merge()
      .setValue('CÁLCULO DE AGUINALDO ' + r.parametros.anioFiscal)
      .setBackground('#0b4f6c')
      .setFontColor('#ffffff')
      .setFontWeight('bold')
      .setFontSize(14)
      .setVerticalAlignment('middle');
    hoja.setRowHeight(1, 34);

    hoja.getRange('A2:C2')
      .merge()
      .setValue('Generado: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') +
        '. Comprobante del último cálculo; no edites los resultados.')
      .setFontStyle('italic')
      .setFontColor('#5d7186');

    escribirSeccion_(hoja, 4, 'DATOS DE ENTRADA');
    escribirFila_(hoja, 5, 'Salario mensual bruto', r.entradas.salarioMensual, FORMATO_MONEDA);
    escribirFila_(hoja, 6, 'Salario diario (÷ ' + r.parametros.diasBaseSalario + ')', r.entradas.salarioDiario, FORMATO_MONEDA);
    escribirFila_(hoja, 7, 'Fecha de ingreso', fechaLocalDesdeISO_(r.entradas.fechaIngreso), FORMATO_FECHA);
    escribirFila_(hoja, 8, 'Fecha de corte', fechaLocalDesdeISO_(r.entradas.fechaCorte), FORMATO_FECHA);
    escribirFila_(hoja, 9, 'Otras deducciones', r.entradas.otrasDeducciones, FORMATO_MONEDA);

    escribirSeccion_(hoja, 11, 'DÍAS Y PROPORCIÓN');
    escribirFila_(hoja, 12, 'Inicio del periodo computable', fechaLocalDesdeISO_(r.dias.inicioComputable), FORMATO_FECHA);
    escribirFila_(hoja, 13, 'Días computables (incluye ambos extremos)', r.dias.diasComputables, '0');
    escribirFila_(hoja, 14, 'Días del ejercicio', r.dias.diasEjercicio, '0');
    escribirFila_(hoja, 15, 'Días de aguinaldo', r.dias.diasAguinaldo, FORMATO_NUMERO);
    escribirFila_(hoja, 16, 'Proporción del año', r.dias.proporcion, FORMATO_PORCENTAJE);

    escribirSeccion_(hoja, 18, 'RESULTADO');
    escribirFila_(hoja, 19, 'Aguinaldo bruto', r.importes.bruto, FORMATO_MONEDA);
    escribirFila_(hoja, 20, 'Parte exenta de ISR', r.importes.exento, FORMATO_MONEDA);
    escribirFila_(hoja, 21, 'Parte gravable de ISR', r.importes.gravable, FORMATO_MONEDA);
    escribirFila_(hoja, 22, 'ISR retenido', r.importes.isr, FORMATO_MONEDA);
    escribirFila_(hoja, 23, 'Cuotas de seguridad social (IMSS obrero, estimadas)', r.importes.imss, FORMATO_MONEDA);
    escribirFila_(hoja, 24, 'Otras deducciones', r.importes.otrasDeducciones, FORMATO_MONEDA);
    escribirFila_(hoja, 25, 'NETO A RECIBIR', r.importes.neto, FORMATO_MONEDA);
    hoja.getRange('A25:C25')
      .setBackground('#e6f4ec')
      .setFontWeight('bold')
      .setFontColor('#0a5c43');
    hoja.getRange('B25').setFontSize(13);

    escribirSeccion_(hoja, 27, 'DETALLE ISR (ART. 96 LISR)');
    escribirFila_(hoja, 28, 'ISR sobre salario sin aguinaldo', r.isr.isrSinAguinaldo, FORMATO_MONEDA);
    escribirFila_(hoja, 29, 'Base: salario + parte gravable', r.isr.baseConAguinaldo, FORMATO_MONEDA);
    escribirFila_(hoja, 30, 'ISR sobre esa base', r.isr.isrConAguinaldo, FORMATO_MONEDA);
    escribirFila_(hoja, 31, 'ISR atribuible al aguinaldo', r.isr.isrAguinaldo, FORMATO_MONEDA);
    escribirFila_(hoja, 32, 'Tramo aplicado', formatearResultado_(r).tramoIsr, null);
    escribirFila_(hoja, 33, 'Método', r.metodo.isr, null, true);
    hoja.getRange('A33:C33').setFontSize(9);
    hoja.setRowHeight(33, 32);

    escribirSeccion_(hoja, 35, 'DETALLE IMSS (CUOTA OBRERA ESTIMADA)');
    escribirFila_(hoja, 36, 'Base atribuible', r.imss.base, FORMATO_MONEDA);
    escribirFila_(hoja, 37, 'Tope de 25 UMA', r.imss.tope, FORMATO_MONEDA);
    escribirFila_(hoja, 38, 'Tasa base', r.imss.tasaBase, FORMATO_PORCENTAJE);
    escribirFila_(hoja, 39, 'Cuota base', r.imss.cuotaBase, FORMATO_MONEDA);
    escribirFila_(hoja, 40, 'Excedente de 3 UMA', r.imss.excedente, FORMATO_MONEDA);
    escribirFila_(hoja, 41, 'Tasa sobre excedente', r.imss.tasaExcedente, FORMATO_PORCENTAJE);
    escribirFila_(hoja, 42, 'Cuota sobre excedente', r.imss.cuotaExcedente, FORMATO_MONEDA);
    escribirFila_(hoja, 43, 'Total IMSS obrero', r.imss.total, FORMATO_MONEDA);
    escribirFila_(hoja, 44, 'Método', r.metodo.imss, null, true);
    hoja.getRange('A44:C44').setFontSize(9);
    hoja.setRowHeight(44, 42);

    escribirSeccion_(hoja, 46, 'PARÁMETROS Y FUENTES');
    escribirFila_(hoja, 47, 'UMA diaria', r.parametros.umaDiaria, FORMATO_MONEDA);
    escribirFila_(hoja, 48, 'Días de aguinaldo por año', r.parametros.diasAguinaldo, '0');
    escribirFila_(hoja, 49, 'Días de UMA exentos de ISR', r.parametros.diasUmaExentos, '0');
    escribirFila_(hoja, 50, 'Límite exento (30 × UMA)', r.importes.limiteExento, FORMATO_MONEDA);
    escribirFila_(hoja, 51, 'Tarifa ISR', 'Mensual ' + r.parametros.anioFiscal + ' (Anexo 8 RMF)', null);
    escribirFila_(hoja, 52, 'Última actualización de parámetros', r.parametros.fechaActualizacion, null);

    escribirSeccion_(hoja, 54, 'FÓRMULAS APLICADAS');
    escribirFormula_(hoja, 55, 'Días computables', 'fecha_corte − máx(fecha_ingreso, 01/01/' + r.parametros.anioFiscal + ') + 1');
    escribirFormula_(hoja, 56, 'Aguinaldo bruto', 'salario_diario × ' + r.parametros.diasAguinaldo + ' × días_computables ÷ ' + r.dias.diasEjercicio);
    escribirFormula_(hoja, 57, 'Exención ISR', 'mín(bruto, ' + r.parametros.diasUmaExentos + ' × UMA diaria)');
    escribirFormula_(hoja, 58, 'ISR del aguinaldo', 'ISR(salario + gravable) − ISR(salario)');
    escribirFormula_(hoja, 59, 'IMSS obrero',
      'mín(bruto, ' + r.parametros.topeSbcUma + ' × UMA × ' + r.parametros.diasBaseSalario + ') × ' +
      formatearPorcentaje_(r.parametros.tasaImssObrera * 100, 3) +
      ' + máx(0, base − 3 × UMA × ' + r.parametros.diasBaseSalario + ') × ' +
      formatearPorcentaje_(r.parametros.tasaImssExcedente * 100, 2));
    escribirFormula_(hoja, 60, 'Neto', 'bruto − ISR − IMSS − otras deducciones');

    hoja.getRange('A62:C62')
      .merge()
      .setValue('ADVERTENCIAS')
      .setBackground('#e8eef5')
      .setFontWeight('bold')
      .setFontColor('#0b4f6c');

    const advertencias = r.advertencias && r.advertencias.length
      ? r.advertencias
      : ['Sin advertencias para este cálculo.'];

    let filaAdvertencia = 63;
    for (const texto of advertencias) {
      hoja.getRange(filaAdvertencia, 1, 1, 3)
        .merge()
        .setValue('• ' + texto)
        .setWrap(true)
        .setFontColor(texto === 'Sin advertencias para este cálculo.' ? '#5d7186' : '#8a5a00');
      hoja.setRowHeight(filaAdvertencia, 30);
      filaAdvertencia += 1;
    }

    const filaNota = filaAdvertencia + 1;
    hoja.getRange(filaNota, 1, 1, 3)
      .merge()
      .setValue('Este comprobante es informativo. No sustituye la asesoría de un contador público ni la determinación oficial de nómina.')
      .setFontStyle('italic')
      .setFontColor('#5d7186')
      .setWrap(true);
    hoja.setRowHeight(filaNota, 30);

    hoja.setFrozenRows(1);
    hoja.getRange('A1').setFontWeight('bold');
  } finally {
    if (bloqueado) lock.releaseLock();
  }
}

/**
 * Escribe una fila etiqueta-valor en la hoja Cálculo.
 */
function escribirFila_(hoja, fila, etiqueta, valor, formato, envolver) {
  hoja.getRange(fila, 1).setValue(etiqueta).setFontWeight('normal');
  const celdaValor = hoja.getRange(fila, 2).setValue(valor);
  if (formato) celdaValor.setNumberFormat(formato);
  if (envolver) hoja.getRange(fila, 2).setWrap(true);
  hoja.getRange(fila, 1).setVerticalAlignment('top');
  hoja.getRange(fila, 2).setVerticalAlignment('top');
}

/**
 * Escribe un encabezado de sección en la hoja Cálculo.
 */
function escribirSeccion_(hoja, fila, titulo) {
  hoja.getRange(fila, 1, 1, 3)
    .merge()
    .setValue(titulo)
    .setBackground('#e8eef5')
    .setFontWeight('bold')
    .setFontColor('#0b4f6c');
}

/**
 * Escribe una fórmula explicativa (texto) en la hoja Cálculo.
 */
function escribirFormula_(hoja, fila, etiqueta, formula) {
  hoja.getRange(fila, 1).setValue(etiqueta).setFontWeight('bold');
  hoja.getRange(fila, 2, 1, 2)
    .merge()
    .setValue(formula)
    .setFontFamily('Consolas')
    .setFontSize(9)
    .setWrap(true);
  hoja.setRowHeight(fila, 30);
}
