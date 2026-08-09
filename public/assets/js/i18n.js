/**
 * Lightweight i18n module — vanilla JS, no dependencies.
 *
 * Usage on any page:
 *   import { initLang, t, renderSwitcher, onLangChange } from './i18n.js';
 *   initLang();
 *   renderSwitcher(document.getElementById('lang-switcher'));
 *   onLangChange(() => renderMyPage());
 *   renderMyPage(); // call once on load
 *
 * Adding a new language: add its key to `translations` below.
 * Adding a new page namespace: add keys under each language object.
 *
 * Translations with HTML markup should use the _html suffix convention
 * and be set via innerHTML by the page renderer (not via data-i18n).
 *
 * Interpolated strings use [TOKEN] syntax — callers replace tokens:
 *   t('checkout', 'success').replace('[N]', n).replace('[BARRIO]', name)
 */

const STORAGE_KEY = 'barrio_lang';

// ─── Translations ─────────────────────────────────────────────────────────────

export const translations = {
  en: {
    common: {
      langName:         'English',
      questions:        'Questions? Come to NoInfo or speak to any barrio support staff.',
      backToWater:      'Water info',
      ok:               'OK',
      cancel:           'Cancel',
      undo:             'Undo',
      confirm:          'Confirm',
      tryAgain:         'Try Again',
      enterManually:    'Enter Manually',
      back:             'Back',
      refresh:          'Refresh',
      loadMore:         'Load more',
      next:             'Next',
      scanAnother:      'Scan another',
      cancelScan:       'Cancel scan',
      offlineSaved:     'Saved offline — will sync when connected',
      offline:          'Offline',
      aimCamera:        'Aim camera at QR code…',
      cameraError:      'Camera error — check permissions',
      lookingUp:        'Looking up…',
      notFound:         'Not found',
      notRecognised:    'Not recognised',
      statusAvailable:  'Available',
      statusCheckedOut: 'Checked out',
      statusRetired:    'Retired',
      statusOut:        'Out',
    },
    water: {
      pageTitle:         'Water sanitation',
      pageSubtitle:      'About the water sanitation indicator on your cube',
      readTitle:         'How to read the sign',
      readDials:         'The dials on the sign show the earliest time the water in this cube is safe to drink. An Elsewhere crew member sets this dial 30 minutes after adding chlorine. Do not use the water before this time.',
      readStrips:        'A test strip is included in the bag on the sign. See the Testing section below for how to use it.',
      processTitle:      'How sanitation works',
      step1Title:        'Delivery',
      step1Body:         'Water is delivered and poured into your cube.',
      step2Title:        'Chlorination',
      step2Body:         'An Elsewhere crew member adds a measured amount of chlorine solution to the cube.',
      step3Title:        'Dial set',
      step3Body:         'The crew member sets the dial on the sign to 30 minutes after the current time.',
      step4Title:        'Contact time',
      step4Body:         'Chlorine needs 30 minutes of contact time to fully disinfect the water.',
      step5Title:        'Safe to use',
      step5Body:         'After the time shown on the dial, the water is safe for drinking and cooking.',
      testingTitle:      'Testing the water',
      testingBody:       'Dip a test strip into the water for 1–2 seconds, then lay it flat and wait 30 seconds. Compare the colour of the strip to the chart on the packet. A valid result shows detectable free chlorine — any colour change from the baseline.',
      testingNoChlorine: 'If your strip shows no chlorine after the dial time has passed, do not use the water. Come to NoInfo or speak to any barrio support staff.',
    },
    item: {
      pageTitle:    'Equipment item',
      systemNote:   'This item is part of the barrio support equipment tracking system.',
      statusOut:    'Currently checked out',
      statusIn:     'Currently available',
      statusRetired:'Retired',
      foundTitle:   'Found this item?',
      foundNote:    'If you\'ve found this equipment, please contact barrio support:',
      loginBtn:     'Log in to manage equipment',
      notFound:     'Item not recognised',
      notFoundNote: 'This QR code wasn\'t found in the system. Please contact barrio support if you think this is an error.',
      contactEmail: '[SUPPORT_EMAIL]',
    },
    home: {
      scan:           'Scan',
      lendToTeam:     'Lend to team',
      lendToTeamSub:  'Choose dept manually',
      barriosMgmt:    'Group arrivals / departures',
      barriosMgmtSub: 'Record check-in and check-out',
    },
    nav: {
      home:       'Home',
      lend:       'Lend',
      scanIn:     'Scan In',
      groups:     'Groups',
      inventory:  'Inventory',
      history:    'History',
      orders:     'Orders',
      admin:      'Admin',
      adminPanel: 'Admin panel',
      myQr:       'My QR code',
      backHome:   '← Home',
      logout:     'Log out',
    },
    checkout: {
      title:            'Lend',
      modeToDept:       'To team',
      modeToPerson:     'To person',
      modeToGroup:      'To group',
      selectTeam:       'Select team',
      selectPerson:     'Select person',
      selectGroup:      'Select group',
      step1:            'Select group',
      step2:            'Scan items',
      step3:            'Finalise',
      aimBarrio:        'Aim camera at group QR code…',
      barrioNotFound:   'Group QR not found',
      typeName:         'Type group name or ID',
      continueItems:    'Continue to Items',
      checkInWithout:   'Check In Without Lending',
      goToBarrio:       'Go to Group',
      aimItem:          'Aim camera at item QR code…',
      alreadyInList:    'Already in list',
      itemUnavailable:  'Item details unavailable — add by QR?',
      qrNotFound:       'QR not in inventory',
      lookupFailed:     'Lookup failed',
      typeQr:           'Type item QR code',
      continueScanning: 'Continue Scanning',
      doneScanning:     'Done Scanning',
      equipmentOrdered: 'Equipment ordered',
      scannedItems:     'Scanned items',
      noItems:          'No items scanned yet',
      reviewLend:       'Review & lend',
      recordArrival:    'Record Arrival — Consumables Given',
      orientation:      'Orientation completed',
      success:          'Lent [N] item(s) to [GROUP]',
    },
    checkin: {
      title:            'Scan In',
      modeReturn:       'Return equipment',
      modeVoucher:      'Validate voucher',
      modeActivate:     'Activate vouchers',
      alreadyReturned:       'Already returned — no action needed',
      confirmReturn:         'Confirm Return',
      notCheckedOut:         'Item was not checked out',
      unavailableQueue:      'Item info unavailable — queue return?',
      returnAnyway:          'Return Anyway',
      returned:              'Returned: [NAME]',
      checkedOutTo:          'Checked out to',
      inDeptPool:            'In dept pool:',
      availableForBorrow:    'Available — check out to a person?',
      borrowCheckOut:        'Check out to person',
      borrowTransfer:        'Transfer to person',
      borrowNotEligible:     'Not eligible to borrow this item',
      borrowRestricted:      'Restricted — not in allowed list',
      borrowNoPermission:    'No permission to borrow',
      borrowShiftSession:    'Shift sessions cannot borrow personal equipment',
      borrowNotBorrowable:   'This item is not available for personal checkout',
      borrowSearchPlaceholder: 'Search by name…',
      borrowDone:            'Checked out to [PERSON]',
    },
    activate: {
      title:            'Activate vouchers',
      aimScanner:       'Scan half-vouchers from the box…',
      activating:       'Activating…',
      activated:        'Activated',
      alreadyActivated: 'Already activated',
      cannotActivate:   'Cannot activate',
      notAVoucher:      'Not a voucher',
      unreadable:       'Unreadable',
      activationFailed: 'Activation failed',
      typeQr:           'Type voucher QR code',
    },
    barrios: {
      title:             'Groups',
      loading:           'Loading…',
      loadFailed:        'Failed to load',
      none:              'None',
      noneConfigured:    'No groups configured',
      itemsOut:          '[N] out',
      arrived:           'Arrived',
      by:                'By',
      orientation:       'Orientation',
      orientationDone:   '✓ Complete',
      orientationNone:   '✗ Not recorded',
      consumables:       'Consumables',
      departed:          'Departed',
      statusExpected:    'Expected',
      statusOnSite:      'On Site',
      statusDeparted:    'Departed',
      clearFilter:       '× Clear',
      sectionArrival:    'Arrival',
      sectionDeparture:  'Departure',
      sectionConsumables:'Consumables',
      sectionEquipment:  'Equipment orders',
      sectionItems:      'Items out',
      recordArrival:     'Record Arrival',
      distributeItems:   'Distribute Items',
      recordDeparture:   'Record Departure',
      confirmArrival:    'Confirm Arrival',
      confirmDeparture:  'Confirm Departure Anyway',
      alreadyRecorded:   'Already recorded:',
      notCheckedIn:      'Group not yet checked in',
      purchased:         'Purchased',
      given:             'Given',
      remaining:         'Remaining',
      arrivalDone:       'Arrival recorded for [BARRIO]',
      departureDone:     'Departure recorded for [BARRIO]',
      distributeDone:    'Distribution recorded for [BARRIO]',
      enterQuantity:     'Enter at least one quantity',
      noConnection:      'No connection — departure requires internet',
      allReturned:       'All items returned',
      itemsStillOut:     '[N] item(s) still checked out',
    },
    inventory: {
      title:     'Inventory',
      colItem:   'Item',
      colStatus: 'Status',
      colBarrio: 'Group',
      empty:     'No items in inventory',
      emptyHint: 'Tap refresh to load',
      failed:    'Failed to load — check connection',
    },
    history: {
      title:        'Transaction log',
      empty:        'No transactions recorded yet',
      failed:       'Failed to load — check connection',
      checkedOutTo: 'Checked out to [BARRIO]',
      returned:     'Returned',
      returnedFrom: 'Returned from [BARRIO]',
      by:           'by [USER]',
      offlineBadge: 'offline',
    },
  },

  es: {
    common: {
      langName:         'Español',
      questions:        '¿Preguntas? Acércate a NoInfo o habla con cualquier miembro del barrio support.',
      backToWater:      'Info del agua',
      ok:               'Aceptar',
      cancel:           'Cancelar',
      undo:             'Deshacer',
      confirm:          'Confirmar',
      tryAgain:         'Reintentar',
      enterManually:    'Introducir manualmente',
      back:             'Volver',
      refresh:          'Actualizar',
      loadMore:         'Cargar más',
      next:             'Siguiente',
      scanAnother:      'Escanear otro',
      cancelScan:       'Cancelar escaneo',
      offlineSaved:     'Guardado sin conexión — se sincronizará al conectar',
      offline:          'Sin conexión',
      aimCamera:        'Apunta la cámara al código QR…',
      cameraError:      'Error de cámara — comprueba los permisos',
      lookingUp:        'Buscando…',
      notFound:         'No encontrado',
      notRecognised:    'No reconocido',
      statusAvailable:  'Disponible',
      statusCheckedOut: 'Prestado',
      statusRetired:    'Retirado',
      statusOut:        'Fuera',
    },
    water: {
      pageTitle:         'Saneamiento del agua',
      pageSubtitle:      'Sobre el indicador de saneamiento del agua en tu cuba',
      readTitle:         'Cómo leer el indicador',
      readDials:         'Los diales del indicador muestran la hora más temprana a la que el agua de esta cuba es segura para beber. Un miembro del equipo de Elsewhere ajusta el dial 30 minutos después de añadir el cloro. No uses el agua antes de esa hora.',
      readStrips:        'En la bolsa del indicador encontrarás una tira reactiva. Consulta la sección de pruebas a continuación para saber cómo usarla.',
      processTitle:      'Cómo funciona el saneamiento',
      step1Title:        'Entrega',
      step1Body:         'El agua se entrega y se vierte en tu cuba.',
      step2Title:        'Cloración',
      step2Body:         'Un miembro del equipo de Elsewhere añade una cantidad medida de solución de cloro a la cuba.',
      step3Title:        'Ajuste del dial',
      step3Body:         'El miembro del equipo ajusta el dial del indicador a 30 minutos después de la hora actual.',
      step4Title:        'Tiempo de contacto',
      step4Body:         'El cloro necesita 30 minutos de contacto para desinfectar completamente el agua.',
      step5Title:        'Lista para usar',
      step5Body:         'Después de la hora que marca el dial, el agua es segura para beber y cocinar.',
      testingTitle:      'Prueba del agua',
      testingBody:       'Sumerge una tira reactiva en el agua durante 1–2 segundos y luego colócala en una superficie plana durante 30 segundos. Compara el color de la tira con la tabla del envase. Un resultado válido muestra cloro libre detectable — cualquier cambio de color respecto al valor base.',
      testingNoChlorine: 'Si la tira no muestra cloro después de que haya pasado la hora del dial, no uses el agua. Acércate a NoInfo o habla con cualquier miembro del barrio support.',
    },
    item: {
      pageTitle:    'Objeto de equipo',
      systemNote:   'Este objeto forma parte del sistema de seguimiento de equipamiento del barrio support.',
      statusOut:    'Actualmente prestado',
      statusIn:     'Actualmente disponible',
      statusRetired:'Retirado',
      foundTitle:   '¿Has encontrado este objeto?',
      foundNote:    'Si has encontrado este equipamiento, ponte en contacto con barrio support:',
      loginBtn:     'Iniciar sesión para gestionar el equipamiento',
      notFound:     'Objeto no reconocido',
      notFoundNote: 'Este código QR no se encontró en el sistema. Contacta con barrio support si crees que es un error.',
      contactEmail: '[SUPPORT_EMAIL]',
    },
    home: {
      scan:           'Escanear',
      lendToTeam:     'Prestar a equipo',
      lendToTeamSub:  'Elegir dpto manualmente',
      barriosMgmt:    'Llegadas y salidas de grupos',
      barriosMgmtSub: 'Registrar llegada y salida',
    },
    nav: {
      home:       'Inicio',
      lend:       'Prestar',
      scanIn:     'Escanear',
      groups:     'Grupos',
      inventory:  'Inventario',
      history:    'Historial',
      orders:     'Pedidos',
      admin:      'Admin',
      adminPanel: 'Panel de admin',
      myQr:       'Mi código QR',
      backHome:   '← Inicio',
      logout:     'Cerrar sesión',
    },
    checkout: {
      title:            'Prestar',
      modeToDept:       'A equipo',
      modeToPerson:     'A persona',
      modeToGroup:      'A grupo',
      selectTeam:       'Seleccionar equipo',
      selectPerson:     'Seleccionar persona',
      selectGroup:      'Seleccionar grupo',
      step1:            'Seleccionar grupo',
      step2:            'Escanear objetos',
      step3:            'Finalizar',
      aimBarrio:        'Apunta la cámara al QR del grupo…',
      barrioNotFound:   'QR de grupo no encontrado',
      typeName:         'Escribe el nombre o ID del grupo',
      continueItems:    'Continuar a objetos',
      checkInWithout:   'Registrar llegada sin préstamo',
      goToBarrio:       'Ir al grupo',
      aimItem:          'Apunta la cámara al QR del objeto…',
      alreadyInList:    'Ya en la lista',
      itemUnavailable:  'Detalles del objeto no disponibles — ¿añadir por QR?',
      qrNotFound:       'QR no encontrado en inventario',
      lookupFailed:     'Búsqueda fallida',
      typeQr:           'Escribe el código QR del objeto',
      continueScanning: 'Seguir escaneando',
      doneScanning:     'Terminar escaneo',
      equipmentOrdered: 'Material pedido',
      scannedItems:     'Objetos escaneados',
      noItems:          'Aún no se han escaneado objetos',
      reviewLend:       'Revisar y prestar',
      recordArrival:    'Registrar llegada — consumibles entregados',
      orientation:      'Orientación completada',
      success:          'Prestado(s) [N] objeto(s) a [GROUP]',
    },
    checkin: {
      title:            'Escanear',
      modeReturn:       'Devolver equipamiento',
      modeVoucher:      'Validar vale',
      modeActivate:     'Activar vales',
      alreadyReturned:       'Ya devuelto — no se requiere acción',
      confirmReturn:         'Confirmar devolución',
      notCheckedOut:         'El objeto no estaba prestado',
      unavailableQueue:      'Info del objeto no disponible — ¿poner en cola?',
      returnAnyway:          'Devolver de todas formas',
      returned:              'Devuelto: [NAME]',
      checkedOutTo:          'Prestado a',
      inDeptPool:            'En el pool del dpto:',
      availableForBorrow:    'Disponible — ¿préstamo personal?',
      borrowCheckOut:        'Prestar a persona',
      borrowTransfer:        'Transferir a persona',
      borrowNotEligible:     'No habilitado para tomar prestado este objeto',
      borrowRestricted:      'Restringido — no está en la lista permitida',
      borrowNoPermission:    'Sin permiso para tomar prestado',
      borrowShiftSession:    'Los turnos no pueden tomar equipo en préstamo personal',
      borrowNotBorrowable:   'Este objeto no está disponible para préstamo personal',
      borrowSearchPlaceholder: 'Buscar por nombre…',
      borrowDone:            'Prestado a [PERSON]',
    },
    activate: {
      title:            'Activar vales',
      aimScanner:       'Escanea los medios vales del buzón…',
      activating:       'Activando…',
      activated:        'Activado',
      alreadyActivated: 'Ya activado',
      cannotActivate:   'No se puede activar',
      notAVoucher:      'No es un vale',
      unreadable:       'Ilegible',
      activationFailed: 'Activación fallida',
      typeQr:           'Escribe el código QR del vale',
    },
    barrios: {
      title:             'Grupos',
      loading:           'Cargando…',
      loadFailed:        'Error al cargar',
      none:              'Ninguno',
      noneConfigured:    'No hay grupos configurados',
      itemsOut:          '[N] fuera',
      arrived:           'Llegó',
      by:                'Por',
      orientation:       'Orientación',
      orientationDone:   '✓ Completo',
      orientationNone:   '✗ No registrado',
      consumables:       'Consumibles',
      departed:          'Se fue',
      statusExpected:    'Esperado',
      statusOnSite:      'En el sitio',
      statusDeparted:    'Se fue',
      clearFilter:       '× Borrar',
      sectionArrival:    'Llegada',
      sectionDeparture:  'Salida',
      sectionConsumables:'Consumibles',
      sectionEquipment:  'Material pedido',
      sectionItems:      'Objetos fuera',
      recordArrival:     'Registrar llegada',
      distributeItems:   'Distribuir material',
      recordDeparture:   'Registrar salida',
      confirmArrival:    'Confirmar llegada',
      confirmDeparture:  'Confirmar salida igualmente',
      alreadyRecorded:   'Ya registrado:',
      notCheckedIn:      'Grupo aún no ha llegado',
      purchased:         'Comprado',
      given:             'Entregado',
      remaining:         'Restante',
      arrivalDone:       'Llegada registrada para [BARRIO]',
      departureDone:     'Salida registrada para [BARRIO]',
      distributeDone:    'Distribución registrada para [BARRIO]',
      enterQuantity:     'Introduce al menos una cantidad',
      noConnection:      'Sin conexión — la salida requiere internet',
      allReturned:       'Todos los objetos devueltos',
      itemsStillOut:     '[N] objeto(s) todavía prestado(s)',
    },
    inventory: {
      title:     'Inventario',
      colItem:   'Objeto',
      colStatus: 'Estado',
      colBarrio: 'Grupo',
      empty:     'No hay objetos en el inventario',
      emptyHint: 'Toca actualizar para cargar',
      failed:    'No se pudo cargar — comprueba la conexión',
    },
    history: {
      title:        'Registro de transacciones',
      empty:        'Aún no hay transacciones registradas',
      failed:       'No se pudo cargar — comprueba la conexión',
      checkedOutTo: 'Prestado a [BARRIO]',
      returned:     'Devuelto',
      returnedFrom: 'Devuelto desde [BARRIO]',
      by:           'por [USER]',
      offlineBadge: 'sin conexión',
    },
  },

  fr: {
    common: {
      langName:         'Français',
      questions:        'Des questions ? Rendez-vous à NoInfo ou parlez à un membre du barrio support.',
      backToWater:      'Info eau',
      ok:               'OK',
      cancel:           'Annuler',
      undo:             'Annuler',
      confirm:          'Confirmer',
      tryAgain:         'Réessayer',
      enterManually:    'Saisir manuellement',
      back:             'Retour',
      refresh:          'Actualiser',
      loadMore:         'Charger plus',
      next:             'Suivant',
      scanAnother:      'Scanner un autre',
      cancelScan:       'Annuler le scan',
      offlineSaved:     'Enregistré hors ligne — synchronisation à la reconnexion',
      offline:          'Hors ligne',
      aimCamera:        'Pointez la caméra vers le QR code…',
      cameraError:      'Erreur caméra — vérifiez les permissions',
      lookingUp:        'Recherche…',
      notFound:         'Introuvable',
      notRecognised:    'Non reconnu',
      statusAvailable:  'Disponible',
      statusCheckedOut: 'Sorti',
      statusRetired:    'Retraité',
      statusOut:        'Sorti',
    },
    water: {
      pageTitle:         'Assainissement de l\'eau',
      pageSubtitle:      'À propos de l\'indicateur d\'assainissement de l\'eau sur votre cuve',
      readTitle:         'Comment lire l\'indicateur',
      readDials:         'Les cadrans de l\'indicateur affichent l\'heure la plus tôt à laquelle l\'eau de cette cuve est sûre à boire. Un membre de l\'équipe Elsewhere règle ce cadran 30 minutes après avoir ajouté le chlore. N\'utilisez pas l\'eau avant cette heure.',
      readStrips:        'Une bandelette de test est incluse dans le sachet fixé à l\'indicateur. Consultez la section Tests ci-dessous pour savoir comment l\'utiliser.',
      processTitle:      'Comment fonctionne l\'assainissement',
      step1Title:        'Livraison',
      step1Body:         'L\'eau est livrée et versée dans votre cuve.',
      step2Title:        'Chloration',
      step2Body:         'Un membre de l\'équipe Elsewhere ajoute une quantité mesurée de solution de chlore dans la cuve.',
      step3Title:        'Réglage du cadran',
      step3Body:         'Le membre de l\'équipe règle le cadran de l\'indicateur à 30 minutes après l\'heure actuelle.',
      step4Title:        'Temps de contact',
      step4Body:         'Le chlore a besoin de 30 minutes de contact pour désinfecter complètement l\'eau.',
      step5Title:        'Prête à utiliser',
      step5Body:         'Après l\'heure indiquée sur le cadran, l\'eau est sûre pour boire et cuisiner.',
      testingTitle:      'Tester l\'eau',
      testingBody:       'Plongez une bandelette de test dans l\'eau pendant 1 à 2 secondes, puis posez-la à plat et attendez 30 secondes. Comparez la couleur de la bandelette au tableau sur l\'emballage. Un résultat valide montre du chlore libre détectable — tout changement de couleur par rapport à la référence.',
      testingNoChlorine: 'Si votre bandelette ne montre aucun chlore après l\'heure du cadran, n\'utilisez pas l\'eau. Rendez-vous à NoInfo ou parlez à un membre du barrio support.',
    },
    item: {
      pageTitle:    'Objet d\'équipement',
      systemNote:   'Cet objet fait partie du système de suivi d\'équipement du barrio support.',
      statusOut:    'Actuellement sorti',
      statusIn:     'Actuellement disponible',
      statusRetired:'Retraité',
      foundTitle:   'Vous avez trouvé cet objet ?',
      foundNote:    'Si vous avez trouvé cet équipement, veuillez contacter le barrio support :',
      loginBtn:     'Se connecter pour gérer l\'équipement',
      notFound:     'Objet non reconnu',
      notFoundNote: 'Ce QR code n\'a pas été trouvé dans le système. Contactez le barrio support si vous pensez que c\'est une erreur.',
      contactEmail: '[SUPPORT_EMAIL]',
    },
    home: {
      scan:           'Scanner',
      lendToTeam:     'Prêter à une équipe',
      lendToTeamSub:  'Choisir le dép. manuellement',
      barriosMgmt:    'Arrivées / départs de groupes',
      barriosMgmtSub: 'Enregistrer les arrivées et départs',
    },
    nav: {
      home:       'Accueil',
      lend:       'Prêter',
      scanIn:     'Scanner',
      groups:     'Groupes',
      inventory:  'Inventaire',
      history:    'Historique',
      orders:     'Commandes',
      admin:      'Admin',
      adminPanel: 'Panneau admin',
      myQr:       'Mon QR code',
      backHome:   '← Accueil',
      logout:     'Déconnexion',
    },
    checkout: {
      title:            'Prêter',
      modeToDept:       'À une équipe',
      modeToPerson:     'À une personne',
      modeToGroup:      'À un groupe',
      selectTeam:       'Choisir l\'équipe',
      selectPerson:     'Choisir la personne',
      selectGroup:      'Choisir le groupe',
      step1:            'Choisir le groupe',
      step2:            'Scanner les objets',
      step3:            'Finaliser',
      aimBarrio:        'Pointez la caméra vers le QR du groupe…',
      barrioNotFound:   'QR de groupe introuvable',
      typeName:         'Tapez le nom ou l\'ID du groupe',
      continueItems:    'Continuer vers les objets',
      checkInWithout:   'Enregistrer arrivée sans prêt',
      goToBarrio:       'Aller au groupe',
      aimItem:          'Pointez la caméra vers le QR de l\'objet…',
      alreadyInList:    'Déjà dans la liste',
      itemUnavailable:  'Détails de l\'objet indisponibles — ajouter par QR ?',
      qrNotFound:       'QR absent de l\'inventaire',
      lookupFailed:     'Recherche échouée',
      typeQr:           'Tapez le QR code de l\'objet',
      continueScanning: 'Continuer à scanner',
      doneScanning:     'Terminer le scan',
      equipmentOrdered: 'Matériel commandé',
      scannedItems:     'Objets scannés',
      noItems:          'Aucun objet scanné pour l\'instant',
      reviewLend:       'Vérifier et prêter',
      recordArrival:    'Enregistrer arrivée — consommables remis',
      orientation:      'Orientation effectuée',
      success:          '[N] objet(s) prêté(s) à [GROUP]',
    },
    checkin: {
      title:            'Scanner',
      modeReturn:       'Retourner le matériel',
      modeVoucher:      'Valider le bon',
      modeActivate:     'Activer les bons',
      alreadyReturned:       'Déjà retourné — aucune action requise',
      confirmReturn:         'Confirmer le retour',
      notCheckedOut:         'L\'objet n\'était pas sorti',
      unavailableQueue:      'Info objet indisponible — mettre en file d\'attente ?',
      returnAnyway:          'Retourner quand même',
      returned:              'Retourné : [NAME]',
      checkedOutTo:          'Sorti pour',
      inDeptPool:            'Dans le pool du dép. :',
      availableForBorrow:    'Disponible — prêt personnel ?',
      borrowCheckOut:        'Prêter à une personne',
      borrowTransfer:        'Transférer à une personne',
      borrowNotEligible:     'Pas autorisé à emprunter cet objet',
      borrowRestricted:      'Restreint — pas dans la liste autorisée',
      borrowNoPermission:    'Pas de permission d\'emprunt',
      borrowShiftSession:    'Les sessions de quart ne peuvent pas emprunter du matériel personnel',
      borrowNotBorrowable:   'Cet objet n\'est pas disponible en prêt personnel',
      borrowSearchPlaceholder: 'Rechercher par nom…',
      borrowDone:            'Prêté à [PERSON]',
    },
    activate: {
      title:            'Activer les bons',
      aimScanner:       'Scannez les demi-bons de la boîte…',
      activating:       'Activation…',
      activated:        'Activé',
      alreadyActivated: 'Déjà activé',
      cannotActivate:   'Impossible à activer',
      notAVoucher:      'Pas un bon',
      unreadable:       'Illisible',
      activationFailed: 'Échec d\'activation',
      typeQr:           'Tapez le QR code du bon',
    },
    barrios: {
      title:             'Groupes',
      loading:           'Chargement…',
      loadFailed:        'Chargement échoué',
      none:              'Aucun',
      noneConfigured:    'Aucun groupe configuré',
      itemsOut:          '[N] sorti(s)',
      arrived:           'Arrivé',
      by:                'Par',
      orientation:       'Orientation',
      orientationDone:   '✓ Terminé',
      orientationNone:   '✗ Non enregistré',
      consumables:       'Consommables',
      departed:          'Parti',
      statusExpected:    'Attendu',
      statusOnSite:      'Sur place',
      statusDeparted:    'Parti',
      clearFilter:       '× Effacer',
      sectionArrival:    'Arrivée',
      sectionDeparture:  'Départ',
      sectionConsumables:'Consommables',
      sectionEquipment:  'Commandes de matériel',
      sectionItems:      'Objets sortis',
      recordArrival:     'Enregistrer arrivée',
      distributeItems:   'Distribuer le matériel',
      recordDeparture:   'Enregistrer départ',
      confirmArrival:    'Confirmer l\'arrivée',
      confirmDeparture:  'Confirmer le départ quand même',
      alreadyRecorded:   'Déjà enregistré :',
      notCheckedIn:      'Groupe pas encore enregistré',
      purchased:         'Acheté',
      given:             'Remis',
      remaining:         'Restant',
      arrivalDone:       'Arrivée enregistrée pour [BARRIO]',
      departureDone:     'Départ enregistré pour [BARRIO]',
      distributeDone:    'Distribution enregistrée pour [BARRIO]',
      enterQuantity:     'Saisissez au moins une quantité',
      noConnection:      'Pas de connexion — le départ nécessite internet',
      allReturned:       'Tous les objets retournés',
      itemsStillOut:     '[N] objet(s) encore sorti(s)',
    },
    inventory: {
      title:     'Inventaire',
      colItem:   'Objet',
      colStatus: 'Statut',
      colBarrio: 'Groupe',
      empty:     'Aucun objet dans l\'inventaire',
      emptyHint: 'Appuyez sur actualiser pour charger',
      failed:    'Échec du chargement — vérifiez la connexion',
    },
    history: {
      title:        'Journal des transactions',
      empty:        'Aucune transaction enregistrée pour l\'instant',
      failed:       'Échec du chargement — vérifiez la connexion',
      checkedOutTo: 'Sorti pour [BARRIO]',
      returned:     'Retourné',
      returnedFrom: 'Retourné depuis [BARRIO]',
      by:           'par [USER]',
      offlineBadge: 'hors ligne',
    },
  },
};

// ─── Core ─────────────────────────────────────────────────────────────────────

const listeners = [];
let currentLang = 'en';

export function getLang() {
  return currentLang;
}

/**
 * Call once on page load. Priority:
 *  1. ?lang= URL param (lets QR codes on printed materials set language)
 *  2. localStorage saved preference
 *  3. Browser language
 *  4. 'en' fallback
 */
export function initLang() {
  const urlLang = new URLSearchParams(window.location.search).get('lang');
  if (urlLang && translations[urlLang]) {
    currentLang = urlLang;
    try { localStorage.setItem(STORAGE_KEY, urlLang); } catch {}
    document.documentElement.lang = currentLang;
    return;
  }
  let saved;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* private browsing */ }
  const browser = navigator.language?.slice(0, 2).toLowerCase();
  currentLang =
    (saved && translations[saved])       ? saved   :
    (browser && translations[browser])   ? browser :
    'en';
  document.documentElement.lang = currentLang;
}

/** Switch to a supported language code. No-op for unknown codes. */
export function setLang(lang) {
  if (!translations[lang] || lang === currentLang) return;
  currentLang = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  document.documentElement.lang = lang;
  _refreshSwitchers();
  applyTranslations();
  listeners.forEach(fn => fn(lang));
}

/** Register a callback fired whenever the language changes. */
export function onLangChange(fn) {
  listeners.push(fn);
}

/**
 * Translate a key within a namespace.
 * t('water', 'pageTitle') → "Water distribution"
 * Falls back to English, then returns a bracketed placeholder if missing.
 */
export function t(namespace, key) {
  return translations[currentLang]?.[namespace]?.[key]
      ?? translations.en?.[namespace]?.[key]
      ?? `[${namespace}.${key}]`;
}

/**
 * Apply translations to all elements with data-i18n="namespace.key".
 * Called automatically by setLang(); also call manually after initLang().
 */
export function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const dot = el.dataset.i18n.indexOf('.');
    if (dot === -1) return;
    const ns  = el.dataset.i18n.slice(0, dot);
    const key = el.dataset.i18n.slice(dot + 1);
    el.textContent = t(ns, key);
  });
}

// ─── Switcher ─────────────────────────────────────────────────────────────────

const switcherEls = [];

/**
 * Render language switcher buttons into a container element.
 * Can be called multiple times on different containers (e.g. header + footer).
 * The container should have class="lang-switcher" for styling.
 */
export function renderSwitcher(container) {
  if (!container) return;
  switcherEls.push(container);
  _buildSwitcher(container);
}

function _buildSwitcher(container) {
  container.innerHTML = Object.keys(translations)
    .map(lang =>
      `<button class="lang-btn${lang === currentLang ? ' active' : ''}" data-lang="${lang}">${lang.toUpperCase()}</button>`
    ).join('');
  container.querySelectorAll('.lang-btn').forEach(btn => {
    btn.onclick = () => setLang(btn.dataset.lang);
  });
}

function _refreshSwitchers() {
  switcherEls.forEach(el => {
    el.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === currentLang);
    });
  });
}
