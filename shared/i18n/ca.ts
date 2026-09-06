// Catalan. Informal register (tu), never vostè (ruling 1). Button labels use
// the imperative, the Catalan UI convention. Proper nouns, commands and the
// word DELETE that the storage confirm asks for stay as they are (ruling 11).

import type { Catalog } from "./en.ts";

export const ca: Catalog = {
  "common.save": "Desa",
  "common.saving": "Desant…",
  "common.saved": "Desat",
  "common.cancel": "Cancel·la",
  "common.close": "Tanca",
  "common.loading": "Carregant…",
  "common.loadingDots": "Carregant...",
  "common.loadingMemory": "Carregant la memòria…",
  "common.memory": "Memòria",
  "common.memoryEditorHint":
    "Aquest editor reescriu el fitxer tal com es mostra. Fes servir una memòria per línia.",
  "common.saveFailed": "No s'ha pogut desar",
  "common.memoryConflict":
    "La memòria ha canviat des que has obert això: torna a obrir el diàleg per editar-ne la darrera versió.",
  "common.memorySaveFailed": "No s'ha pogut desar la memòria",
  "common.unread": "sense llegir",
  "common.roomFallback": "Sala {number}",
  "common.nextConversation": "Els canvis s'apliquen a la conversa següent.",
  "common.schedule": "Programació",
  "common.discardPrompt": "Vols descartar els canvis sense desar?",
  "common.delete": "Elimina",
  "common.confirmQuestion": "Ho confirmes?",
  "common.settings": "Configuració",
  "common.theme": "Tema",
  "common.preferences": "Preferències",
  "common.checking": "Comprovant…",
  "common.copied": "Copiat",
  "common.copy": "Copia",
  "common.device": "Dispositiu",
  "common.discard": "Descarta",
  "common.justNow": "ara mateix",
  "common.name": "Nom",
  "common.noRooms": "Encara no hi ha sales.",
  "common.prefix": "Prefix",
  "common.revoke": "Revoca",
  "common.rules": "Regles",
  "common.role": "Rol",
  "common.rooms": "Sales",
  "common.signOut": "Tanca la sessió",
  "common.user": "Usuari",
  "common.schedules": "Programacions",
  "common.apps": "Apps",
  "common.changeTheme": "Canvia el tema",

  "nav.showAgentList": "Mostra la llista d'agents",
  "nav.showFloorView": "Mostra la vista de planta",

  "preferences.intro":
    "Et segueixen a tots els dispositius des dels quals inicies la sessió. La configuració específica d'aquest navegador és a Els meus dispositius.",
  "preferences.language": "Idioma",
  "preferences.languageHint":
    "L'idioma en què escriuen els teus agents, i el que fan servir l'entrada de veu i la lectura en veu alta. Els agents l'apliquen a la conversa següent. La resta de la interfície continua en anglès de moment.",
  "preferences.saved": "Desat.",
  "preferences.saveFailed": "No s'ha pogut desar",

  "settings.backToOffice": "Torna a l'oficina",
  "settings.selectHint": "Tria una opció de la llista",
  "settings.profilesNote":
    "Els perfils d'usuari es desen al servidor. Les teves notificacions i credencials et segueixen entre dispositius.",
  "settings.signOutHint": "Tanca la sessió d'aquest dispositiu",
  "settings.you": "(tu)",
  "settings.sidebar.office": "Oficina",
  "settings.sidebar.access": "Accés",
  "settings.sidebar.invites": "Invitacions",
  "settings.sidebar.sessions": "Sessions",
  "settings.sidebar.connectionsOffice": "Connexions de tota l'oficina",
  "settings.sidebar.usage": "Ús",
  "settings.sidebar.storage": "Emmagatzematge",
  "settings.sidebar.updates": "Actualitzacions",
  "settings.sidebar.profile": "Perfil",
  "settings.sidebar.connectionsPersonal": "Connexions individuals",
  "settings.sidebar.apiTokens": "Tokens d'API",
  "settings.sidebar.signInLinks": "Enllaços d'inici de sessió",
  "settings.sidebar.deviceLabel": "Etiqueta del dispositiu",
  "settings.sidebar.members": "Membres",
  "settings.members.editHint":
    "Només el mateix usuari i els propietaris poden editar un usuari",
  "settings.members.onlineNow": "En línia ara",
  "settings.members.online": "en línia",
  "settings.members.onlineSessions.one": "en línia · {count} sessió",
  "settings.members.onlineSessions.other": "en línia · {count} sessions",
  "settings.members.lastSeen": "vist per última vegada {when}",
  "settings.role.owner": "propietari",
  "settings.role.member": "membre",
  "settings.role.ownerHint":
    "Propietari - pot convidar usuaris, revocar sessions i fixar l'accés a sales de cada usuari",
  "settings.role.memberHint":
    "Membre - pot actuar a les sales que el propietari li ha permès; no pot convidar ni revocar",

  "settings.profile.identity": "Identitat",
  "settings.profile.displayName": "Nom visible",
  "settings.profile.accessHint":
    "Accés: sales que aquest usuari pot veure i on pot actuar (ho gestiona el propietari).",
  "settings.profile.viewHint":
    "Mostrades: quines de les teves sales accessibles apareixen a la teva vista. Notificacions: so quan un agent d'aquella sala acaba. Una sala ha d'estar mostrada per notificar.",
  "settings.profile.roomColumn": "Sala",
  "settings.profile.accessColumn": "Accés",
  "settings.profile.displayedColumn": "Mostrada",
  "settings.profile.notificationsColumn": "Notificacions",
  "settings.profile.accessTo": "Accés a {room}",
  "settings.profile.display": "Mostra {room}",
  "settings.profile.notificationsFor": "Notificacions de {room}",
  "settings.profile.agentContext": "Context per als agents",
  "settings.profile.profilePrompt": "Prompt de perfil",
  "settings.profile.profilePromptHint":
    "(s'injecta al prompt de sistema dels agents que tens; els agents d'altres usuaris el poden consultar si necessiten context sobre tu)",
  "settings.profile.profilePromptTitle": "{user} · Prompt de perfil",
  "settings.profile.profilePromptExpandedHint":
    "S'injecta al prompt de sistema dels agents d'aquest usuari; els agents d'altres usuaris el poden consultar si necessiten context sobre ell.",
  "settings.profile.profilePromptPlaceholder":
    "Unes notes per als agents sobre qui ets, el teu rol, com t'agrada col·laborar…",
  "settings.profile.memoryHint":
    "(fets duradors sobre aquest usuari; reescriu el fitxer tal com es mostra - una memòria per línia; {size} / {cap})",
  "settings.profile.memoryTitle": "{user} · Memòria",
  "settings.profile.memoryPlaceholder":
    "Alguna memòria rellevant per a aquest usuari",
  "settings.profile.appearance": "Aparença",
  "settings.profile.avatarHint":
    "(el teu fantasma a l'escena de l'oficina; els altres usuaris el veuen al costat de l'agent que estàs mirant)",
  "settings.profile.deleteHint": "Elimina aquest usuari",
  "settings.profile.deleteFailed": "No s'ha pogut eliminar",
  "settings.profile.roomListFailed":
    "No s'ha pogut confirmar la teva llista de sales; Mostrades no s'ha desat.",

  "settings.office.title": "Configuració de l'oficina",
  "settings.office.intro":
    "El rètol emmarcat de la paret de l'oficina obre aquesta pàgina.",
  "settings.office.viewOnly":
    "Només lectura. Només els propietaris de l'oficina poden editar la configuració de tota l'oficina.",
  "settings.office.name": "Nom de l'oficina",
  "settings.office.nameHint":
    "(opcional, es mostra a la pestanya del navegador)",
  "settings.office.namePlaceholder": "Oficina del Nil",
  "settings.office.rulesHint": "(prompt de sistema per a tots els agents)",
  "settings.office.rulesTitle": "Regles de l'oficina",
  "settings.office.rulesExpandedHint":
    "Prompt de sistema per a tots els agents. Els canvis s'apliquen a la conversa següent.",
  "settings.office.rulesPlaceholder":
    "p. ex. Escriu sempre tests. Fes servir TypeScript. Sigues concís.",
  "settings.office.memoryHint":
    "(fets duradors de tota l'oficina; línies en brut; {size} / {cap})",
  "settings.office.memoryTitle": "Memòria de l'oficina",
  "settings.office.memoryPlaceholder":
    "Alguna memòria rellevant per a tota l'oficina",
  "settings.office.reloadFailed":
    "Desat, però aquesta pàgina no ha pogut recarregar l'oficina. Tria una altra fila i torna per continuar editant.",
  "settings.office.conflict":
    "La configuració de l'oficina ha canviat en un altre lloc des que es va carregar aquesta pàgina. Tria una altra fila i torna per carregar l'última versió.",
  "settings.office.loadedVariables.one": "S'ha carregat {count} variable.",
  "settings.office.loadedVariables.other": "S'han carregat {count} variables.",
  "settings.office.discardConfirm":
    "Vols descartar els canvis de l'oficina sense desar?",

  "settings.room.title": "{room} · Configuració",
  "settings.room.intro":
    "Fes doble clic en una pestanya de sala per venir directament aquí.",
  "settings.room.namePlaceholder": "Nom de la sala",
  "settings.room.prompt": "Prompt de la sala",
  "settings.room.promptHint":
    "(opcional, s'afegeix després del prompt de l'oficina)",
  "settings.room.promptTitle": "{room} · Prompt de la sala",
  "settings.room.promptPlaceholder":
    "p. ex. Ets a la sala de Màrqueting. Segueix la veu de la nostra marca.",
  "settings.room.promptNote":
    "Els canvis s'apliquen a la conversa següent. Defineix les variables d'entorn a Connexions de tota l'oficina o Connexions individuals.",
  "settings.room.memoryHint":
    "(fets duradors d'aquesta sala; línies en brut; {size} / {cap})",
  "settings.room.memoryTitle": "{room} · Memòria",
  "settings.room.memoryPlaceholder":
    "Alguna memòria rellevant per a aquesta sala",
  "settings.room.reloadFailed":
    "Desat, però aquesta pàgina no ha pogut recarregar la sala. Tria una altra fila i torna per continuar editant.",
  "settings.room.conflict":
    "La configuració de la sala ha canviat en un altre lloc des que es va carregar aquesta pàgina. Tria una altra fila i torna per carregar l'última versió.",
  "settings.room.deleteEmpty": "Elimina la sala buida",
  "settings.room.discardConfirm":
    "Vols descartar els canvis d'aquesta sala sense desar?",

  "settings.theme.intro":
    "Es desa en aquest navegador. També pots fer clic a la finestra de l'oficina per recórrer els temes sense obrir aquesta pàgina.",

  "settings.device.intro":
    'Es desa en aquest navegador. Diu als agents en quin dispositiu ets (per exemple "Mòbil" davant de "Portàtil") perquè adaptin les respostes.',
  "settings.device.label": "Etiqueta del dispositiu",
  "settings.device.optional": "(opcional)",
  "settings.device.placeholder": "Mòbil, Portàtil, …",
  "settings.device.discardConfirm":
    "Vols descartar els canvis de l'etiqueta del dispositiu sense desar?",

  "settings.devices.title": "Els meus dispositius",
  "settings.devices.outstandingLinks": "Enllaços de dispositiu pendents",
  "settings.devices.activeSessions": "Les meves sessions actives",
  "settings.devices.generateHint":
    "Genera un enllaç d'un sol ús per iniciar la sessió amb un altre dels teus dispositius al teu compte. L'enllaç caduca en 1 hora; generar-ne un de nou substitueix l'anterior.",
  "settings.devices.generateWarning":
    "Qualsevol que tingui l'enllaç pot iniciar la sessió com tu fins que caduqui o es faci servir - tracta'l com una contrasenya d'un sol ús i obre'l només al teu propi dispositiu.",
  "settings.devices.generating": "Generant…",
  "settings.devices.generate": "Genera un enllaç de dispositiu",
  "settings.devices.generateFailed":
    "No s'ha pogut generar l'enllaç de dispositiu",

  "settings.update.newRelease": "Nova versió disponible",
  "settings.update.upToDateTitle": "Actualitzat",
  "settings.update.upToDate": "Aquesta oficina està actualitzada.",
  "settings.update.releaseNotesParen": "(notes de la versió)",
  "settings.update.githubParen": "(GitHub)",
  "settings.update.toUpdate": "Per actualitzar:",
  "settings.update.stepPull": "Descarrega els últims canvis",
  "settings.update.stepInstall": "Executa <code>bun install</code>",
  "settings.update.stepRestart":
    "Reinicia isomux perquè l'actualització s'apliqui. Desenvolupament: <code>bun run dev</code>. Servei d'usuari: <code>systemctl --user restart isomux</code>. Servei de sistema: <code>sudo systemctl restart isomux</code>.",
  "settings.update.tip":
    "Consell: prem el botó de copiar per copiar aquest avís al porta-retalls i després demana a qualsevol agent que se n'encarregui.",
  "settings.update.requested":
    "Actualització sol·licitada. El servidor es reiniciarà aviat i aquesta pàgina es tornarà a connectar. Si no passa res al cap d'uns minuts, revisa el fitxer d'estat de l'actualitzador al servidor.",
  "settings.update.runningOn": "Ets a <code>{version}</code>",
  "settings.update.unknownVersion": "una versió desconeguda",
  "settings.update.latestRelease":
    "Última versió: <code>{tag}</code>{published}",
  "settings.update.releaseNotes": "notes de la versió",
  "settings.update.restartWarning":
    "Actualitzar reinicia el servidor i interromp tots els agents.",
  "settings.update.busyNone": "Cap agent és a mitja tasca ara mateix.",
  "settings.update.busy.one": "{count} agent és a mitja tasca ara mateix.",
  "settings.update.busy.other": "{count} agents són a mitja tasca ara mateix.",
  "settings.update.busyUnavailable":
    "El recompte d'agents ocupats no està disponible ara mateix.",
  "settings.update.ownerOnly":
    "Un propietari de l'oficina la pot aplicar des d'aquest diàleg.",
  "settings.update.updateNow": "Actualitza ara",
  "settings.update.updateNowBusy": "Actualitza ara ({count} ocupats)",
  "settings.update.updating": "Actualitzant…",
  "settings.update.gotIt": "Entesos",

  "settings.usage.title": "Ús de l'oficina",
  "settings.usage.intro":
    "Els límits del pla de subscripció no es mostren aquí. Aquesta pàgina informa de l'ús de tokens i del cost estimat que registra Isomux.",
  "settings.usage.scoped":
    "Limitat a les sales a què tens accés. L'ús de les programacions no s'hi inclou.",
  "settings.usage.loadFailed": "No s'ha pogut carregar l'ús.",
  "settings.usage.agents": "Ús per agent",
  "settings.usage.rooms": "Ús per sala",
  "settings.usage.roomsNote":
    "Els agents eliminats compten a l'última sala on van ser.",
  "settings.usage.roomColumn": "Sala",
  "settings.usage.deleted": "eliminada",
  "settings.usage.schedules": "Ús per programació",
  "settings.usage.total": "Total",
  "settings.usage.officeTotal": "Total de l'oficina",
  "settings.usage.inSession": "Entrada (ses.)",
  "settings.usage.outSession": "Sortida (ses.)",
  "settings.usage.costSession": "$ (ses.)",
  "settings.usage.inLifetime": "Entrada (total)",
  "settings.usage.outLifetime": "Sortida (total)",
  "settings.usage.costLifetime": "$ (total)",
  "settings.usage.cacheHit": "{count} ({hit} % d'encerts)",

  "settings.storage.title": "Emmagatzematge de l'oficina",
  "settings.storage.category.transcripts": "Transcripcions de converses",
  "settings.storage.category.attachments": "Adjunts del xat",
  "settings.storage.category.sessionMetadata": "Metadades de sessió",
  "settings.storage.category.codexHome": "Directori de Codex",
  "settings.storage.category.providerHomes":
    "Directoris personals de proveïdors",
  "settings.storage.category.cronjobs": "Historial de programacions",
  "settings.storage.category.otherState": "Tota la resta",
  "settings.storage.category.backups": "Còpies de seguretat",
  "settings.storage.category.updateSnapshots": "Instantànies d'actualització",
  "settings.storage.skip.tooRecent": "més recents que el límit d'antiguitat",
  "settings.storage.skip.keepNewest":
    "entre les més recents que es conserven per al seu agent",
  "settings.storage.skip.activeSession":
    "pertanyen a una conversa que encara és activa",
  "settings.storage.skip.forkAncestor":
    "una altra conversa s'ha bifurcat a partir d'elles",
  "settings.storage.skip.referenced":
    "encara es mostren en una conversa que pots llegir",
  "settings.storage.skip.queueStateUnknown":
    "esperen en una cua de missatges que no s'ha pogut llegir",
  "settings.storage.measureFailed": "No s'ha pogut mesurar l'emmagatzematge.",
  "settings.storage.previewFailed": "La sol·licitud de neteja ha fallat.",
  "settings.storage.deleteFailed": "La sol·licitud d'esborrat ha fallat.",
  "settings.storage.deleteDidNotRun":
    "L'esborrat no s'ha executat. No s'ha eliminat res.",
  "settings.storage.leaveConfirm":
    "Encara hi ha una neteja en marxa. Si surts ara perds l'únic informe del que ha esborrat. Vols sortir igualment?",
  "settings.storage.deleteSection": "Esborra fitxers antics",
  "settings.storage.deleteWarningLead":
    "Això esborra fitxers d'aquesta màquina de manera permanent.",
  "settings.storage.deleteWarningBody":
    "No hi ha desfer ni paperera. Les converses i els adjunts antics només s'esborren quan executes aquesta neteja.",
  "settings.storage.whatToDelete": "Què esborrar",
  "settings.storage.olderThan": "Més antics que",
  "settings.storage.daysHint":
    "dies. Tot el que s'ha tocat més recentment es conserva.",
  "settings.storage.keepPerAgent": "Conserva sempre, per agent",
  "settings.storage.keepHint":
    "converses més recents, per antigues que siguin. 0 no en conserva cap per aquest criteri.",
  "settings.storage.preview": "Previsualitza què s'esborraria",
  "settings.storage.measuring": "Mesurant…",
  "settings.storage.onDisk": "Què hi ha al disc",
  "settings.storage.totalSplit":
    "<strong>{total} en total</strong> - {state} d'estat de l'oficina, més {outside} fora d'ell.",
  "settings.storage.totalAllState":
    "<strong>{total} en total</strong>, tot estat de l'oficina.",
  "settings.storage.measured": "Mesurat {when}.",
  "settings.storage.totalOfficeState": "Total de l'estat de l'oficina",
  "settings.storage.outsideOfficeState": "Fora de l'estat de l'oficina",
  "settings.storage.none": "cap",
  "settings.storage.outsideNote":
    "Les còpies de seguretat i les instantànies d'actualització són fora del directori d'estat de l'oficina, així que es llisten després del seu subtotal. “cap” vol dir que aquesta ubicació no està configurada en aquesta màquina.",
  "settings.storage.backupUnavailable":
    "Estat de les còpies de seguretat no disponible.",
  "settings.storage.noBackupYet": "Encara no s'ha fet cap còpia de seguretat.",
  "settings.storage.lastBackupOk":
    "Última còpia de seguretat {when}, correcta.",
  "settings.storage.lastBackupFailed":
    "Última còpia de seguretat {when} FALLIDA.",
  "settings.storage.lastBackupFailedWith":
    "Última còpia de seguretat {when} FALLIDA: {error}",
  "settings.storage.backupKeeping":
    "Es conserven {retention} a <code>{destDir}</code>.",
  "settings.storage.planCount":
    "S'esborrarien {count} {target}, alliberant {size}.",
  "settings.storage.planEmpty":
    "Res no coincideix. Cap de les {target} és prou antiga per esborrar-la.",
  "settings.storage.planPreviewNote":
    "Encara no s'ha esborrat res - això és una previsualització.",
  "settings.storage.skippedRow": "{count} conservades ({size}): {reason}",
  "settings.storage.sampleRow": "{path} - {size}, {age} d d'antiguitat",
  "settings.storage.sampleMore": "…i {count} més.",
  "settings.storage.queueUnreadable":
    "Isomux no ha pogut llegir la cua de missatges pendents, així que no pot saber quins adjunts encara s'han d'entregar amb missatges pendents. No s'esborrarà res fins que es pugui tornar a llegir.",
  "settings.storage.deleteCount":
    "Esborra {count} {target} de manera permanent",
  "settings.storage.cannotUndo": "Això no es pot desfer.",
  "settings.storage.confirmBody":
    "La previsualització ha trobat {size} de {target} per esborrar d'aquesta màquina. Una còpia de seguretat pot contenir una altra còpia, si s'ha fet després d'escriure aquests fitxers. Isomux torna a escanejar abans d'esborrar. Els fitxers que ja no coincideixen o no passen una comprovació de seguretat es conserven, així que el recompte final pot diferir d'aquesta previsualització.",
  "settings.storage.confirmPlaceholder": "Escriu DELETE per confirmar",
  "settings.storage.deleting": "Esborrant…",
  "settings.storage.deletePermanently": "Esborra de manera permanent",
  "settings.storage.aborted": "S'ha aturat abans d'esborrar res: {reason}",
  "settings.storage.deletedResult":
    "S'han esborrat {count} fitxers, alliberant {size}.",
  "settings.storage.refused":
    "{count} no s'han pogut eliminar i s'han deixat com estaven.",

  "settings.access.none": "Cap.",
  "settings.access.expired": "caducada",
  "settings.access.expiresUnderHour": "0 h",
  "settings.access.localTime": "{time} local",
  "settings.access.inviteUrl": "URL d'invitació",
  "settings.access.copyUrl": "Copia la URL",
  "settings.access.urlCopied": "Copiada!",
  "settings.access.clipboardBlocked":
    "Porta-retalls bloquejat. La URL de dalt està seleccionada - copia-la a mà.",
  "settings.access.sendUrl":
    "Envia aquesta URL a la persona convidada. És d'un sol ús: en obrir-la al seu dispositiu, hi entra. La URL es mostra un cop - copia-la ara.",

  "settings.invites.intro":
    "Afegeix un membre o un propietari: emet una URL d'invitació i envia-l'hi per un altre canal. En obrir-la es crea el seu compte i aquell dispositiu hi entra. Per a més dispositius en un compte que ja existeix, cadascú genera el seu propi enllaç des de <i>Els meus dispositius</i>.",
  "settings.invites.issueFor": "Emet una invitació per a…",
  "settings.invites.namePlaceholder": "Nom nou (p. ex. Marc)",
  "settings.invites.existing":
    "<b>{name}</b> ja existeix, així que no cal cap invitació: per entrar amb un altre dispositiu, {name} pot generar un enllaç des d'<i>Els meus dispositius</i> a la seva configuració - o li pots emetre un enllaç de recuperació aquí sota.",
  "settings.invites.grantRoom": "Dona accés a {room}",
  "settings.invites.roomsHint":
    "La persona convidada hi entra amb accés a les sales marcades. Deixa-les totes sense marcar per donar-li accés més tard des de la seva configuració.",
  "settings.invites.expiryHint":
    "L'enllaç d'invitació caduca 24 h després d'emetre'l si no s'usa. Les sessions acceptades duren fins a 1 any (revocables des de la secció Sessions en qualsevol moment).",
  "settings.invites.minting": "Emetent…",
  "settings.invites.issue": "Emet la invitació",
  "settings.invites.mintFailed": "No s'ha pogut emetre la invitació",
  "settings.invites.recovery": "Recuperació",
  "settings.invites.recoveryHint":
    "Ajuda algú que ja té compte a tornar a entrar. Els enllaços de dispositiu són autoservei, però qui ha sortit de tots els seus dispositius no se'n pot generar cap - tria'l aquí i envia-li l'enllaç per un altre canal. Caduca en 24 h; en emetre'n un de nou se substitueix l'anterior.",
  "settings.invites.selectUser": "Tria algú…",
  "settings.invites.mintRecovery": "Emet un enllaç de recuperació",
  "settings.invites.recoveryFailed":
    "No s'ha pogut emetre l'enllaç de recuperació",
  "settings.invites.outstanding": "Invitacions pendents",
  "settings.invites.columnFor": "Per a",
  "settings.invites.columnExpires": "Caduca",
  "settings.invites.bootstrap": "(inicial)",

  "settings.sessions.intro":
    "Dispositius que han entrat en aquesta oficina, de tothom. Revocar una sessió en treu aquell dispositiu. Qui és nou rep una invitació des de la secció Invitacions; qui ja té compte afegeix dispositius des d'<i>Els meus dispositius</i>.",
  "settings.sessions.columnLastSeen": "Vist per última vegada",
  "settings.sessions.columnCreated": "Creada",
  "settings.sessions.currentSession": "Sessió actual",
  "settings.sessions.currentSessionHint":
    "Fes servir Tanca la sessió al final de la barra lateral per acabar la teva sessió actual.",
  "settings.sessions.expiryInactivity": "Caduca per inactivitat",
  "settings.sessions.expiryLatest": "Caduca com a molt tard",

  "settings.externalAccess.intro":
    "Controla si es pot arribar a aquesta oficina des de fora d'aquesta màquina. Els enllaços d'invitació i els dispositius que hi han entrat són a les seccions Invitacions i Sessions.",
  "settings.externalAccess.title": "Accés extern",
  "settings.externalAccess.loopback":
    "Ara mateix només per loopback. S'arriba a l'oficina des d'aquesta màquina, o des d'altres a través d'un túnel SSH.",
  "settings.externalAccess.external":
    "Ara mateix accepta connexions externes. S'arriba a l'oficina des de qualsevol lloc on resolgui la URL pública.",
  "settings.externalAccess.enable": "Activa l'accés extern",
  "settings.externalAccess.publicUrl": "URL pública",
  "settings.externalAccess.urlHint":
    "Patró: {pattern} (l'adreça que obriràs des del portàtil o el mòbil). Desar no canvia per si sol la interfície on escolta el servidor - reinicia isomux per aplicar-ho.",
  "settings.externalAccess.envInvalid":
    "Nota: <code>ISOMUX_PUBLIC_ORIGIN</code> està definida a l'entorn però no és un origen públic vàlid, així que el servidor la ignora. Treu-la del teu fitxer d'entorn o posa-li <code>{pattern}</code> o <code>{localhost}</code>.",
  "settings.externalAccess.envMatches":
    "Nota: <code>ISOMUX_PUBLIC_ORIGIN={origin}</code> està definida a l'entorn i coincideix amb aquesta URL pública. La variable d'entorn està obsoleta - treu-la del teu fitxer d'entorn quan hagis desat aquest valor a la configuració de l'oficina.",
  "settings.externalAccess.envConflict":
    "Nota: <code>ISOMUX_PUBLIC_ORIGIN={origin}</code> està definida a l'entorn. En reiniciar tindria prioritat sobre qualsevol valor diferent desat aquí, així que es rebutjarà el desament fins que igualis aquesta URL al valor de l'entorn o treguis la variable de l'entorn del servei.",
  "settings.externalAccess.discardPrompt":
    "Vols descartar els canvis d'accés extern sense desar?",
  "settings.externalAccess.updateFailed":
    "No s'ha pogut actualitzar la configuració",
  "settings.externalAccess.restartNote":
    "Desat. Reinicia isomux perquè la nova interfície d'escolta tingui efecte. Servei d'usuari: <code>systemctl --user restart isomux</code>. Servei del sistema: <code>sudo systemctl restart isomux</code>.",
  "settings.externalAccess.signInAfterRestart":
    "Després del reinici, obre aquesta URL al dispositiu que vulguis fer servir des de l'adreça pública. (Caduca 1 hora després d'emetre-la.)",

  "settings.apiTokens.intro":
    "Fes anar la teva oficina des de scripts i automatitzacions, i llegeix el que responen els teus agents. Un token té les teves mateixes capacitats, tret de canviar qui pot entrar a l'oficina. Mira la <link>guia de l'API per a desenvolupament</link> per a tot el que pot fer un token.",
  "settings.apiTokens.howToUse": "Com es fa servir",
  "settings.apiTokens.namePlaceholder": "Script del portàtil",
  "settings.apiTokens.expiresAfter": "Caduca al cap de",
  "settings.apiTokens.unlimited": "Sense límit",
  "settings.apiTokens.creating": "Creant…",
  "settings.apiTokens.create": "Crea el token",
  "settings.apiTokens.copyNow": "Copia aquest token ara",
  "settings.apiTokens.shownOnce": "No es tornarà a mostrar.",
  "settings.apiTokens.empty": "No hi ha tokens d'API.",
  "settings.apiTokens.neverExpires": "no caduca mai",
  "settings.apiTokens.expiresOn": "caduca el {date}",
  "settings.apiTokens.lastRequest": "Última petició autenticada: {when}",
  "settings.apiTokens.about": "cap al {date}",
  "settings.apiTokens.never": "mai",
  "settings.apiTokens.loadFailed": "No s'han pogut carregar els tokens d'API",
  "settings.apiTokens.createFailed": "No s'ha pogut crear el token d'API",
  "settings.apiTokens.revokeFailed": "No s'ha pogut revocar el token d'API",

  "settings.connections.officeIntro":
    "Els comptes i les variables que fa servir cada agent d'aquesta oficina. Les credencials les guarda el proveïdor, no pas nosaltres.",
  "settings.connections.personalIntro":
    "Els comptes i les variables que fan servir els agents que crees tu. Tenen prioritat sobre els de l'oficina. Les credencials les guarda el proveïdor, no pas nosaltres.",
  "settings.connections.refresh": "Actualitza",
  "settings.connections.refreshing": "Actualitzant…",
  "settings.connections.checkFailed":
    "No s'han pogut comprovar els comptes de proveïdor.",
  "settings.connections.envTitle": "Variables d'entorn",
  "settings.connections.officeVars":
    "Variables per a cada agent d'aquesta oficina",
  "settings.connections.officeVarsHint":
    "Aquestes variables es carreguen per a cada agent tret que una variable d'usuari tingui prioritat.",
  "settings.connections.ownerManaged":
    "Les variables de tota l'oficina les gestiona una persona propietària.",
  "settings.connections.personalVars": "Variables per als agents que creo",
  "settings.connections.personalVarsHint":
    "Aquestes variables es carreguen per als agents que crees i tenen prioritat sobre les de tota l'oficina.",
  "settings.connections.providerKeyNote":
    "Afegeix <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code> o <code>OPENCODE_API_KEY</code> per fer servir claus d'API del proveïdor. La resta de variables per usuari funcionen igual; per exemple, cada membre pot posar <code>GH_TOKEN</code> perquè els seus agents facin servir les seves pròpies credencials de GitHub. Després fes <code>/clear</code> als agents per aplicar els canvis.",
  "settings.connections.crossLinkFromOffice":
    "Les teves pròpies sessions i variables, que tenen prioritat sobre aquestes, són a <link>Tu → Connexions individuals</link>.",
  "settings.connections.crossLinkFromPersonal":
    "Les sessions i variables de tota l'oficina sobre les quals aquestes tenen prioritat són a <link>Oficina → Connexions de tota l'oficina</link>.",

  "settings.signIn.apiKeyNote":
    "Vols fer servir un token d'API? Mira Configuració → Tu → Connexions individuals.",
  "settings.signIn.scopeOffice":
    "Tota l'oficina: inicia la sessió per a cada agent d'aquesta oficina",
  "settings.signIn.scopePersonal":
    "Individual: inicia la sessió per als agents que creo",
  "settings.signIn.officeHint":
    "Aquesta subscripció es fa servir per a cada agent de l'oficina tret dels que crea un membre que hagi configurat les seves <link>Connexions individuals</link>.",
  "settings.signIn.personalHint":
    "Fes servir un compte a part per als teus agents.",
  "settings.signIn.status": "Estat:",
  "settings.signIn.checking": "Comprovant la connexió…",
  "settings.signIn.waiting": "Esperant el proveïdor…",
  "settings.signIn.connectedAs": "Connectat com a {account}",
  "settings.signIn.connected": "Connectat",
  "settings.signIn.unavailable": "Connexió no disponible",
  "settings.signIn.notConnected": "Sense connectar",
  "settings.signIn.startFailed":
    "No s'ha pogut iniciar la sessió a {provider}.",
  "settings.signIn.submitFailed": "No s'ha pogut enviar el codi de Claude.",
  "settings.signIn.cancelFailed": "No s'ha pogut cancel·lar l'inici de sessió.",
  "settings.signIn.signOutFailed":
    "No s'ha pogut tancar la sessió de {provider}.",
  "settings.signIn.externalWarning":
    "Això tanca la sessió de {provider} en aquesta màquina, fins i tot fora de l'oficina.",
  "settings.signIn.directoryWarning":
    "Això treu la sessió del directori de comptes que vas triar.",
  "settings.signIn.pasteCode": "Enganxa el codi de Claude:",
  "settings.signIn.submitCode": "Envia el codi",
  "settings.signIn.cancelSignIn": "Cancel·la l'inici de sessió",
  "settings.signIn.signingIn": "Iniciant la sessió…",
  "settings.signIn.signIn": "Inicia la sessió",
  "settings.signIn.codexHint":
    "En iniciar la sessió et donem un codi d'un sol ús per escriure'l a la pàgina d'OpenAI. La pàgina s'obre en una pestanya nova; també la pots obrir en qualsevol altre dispositiu.",
  "settings.signIn.claudeHint":
    "Claude s'obre al teu navegador. Quan hi hagis iniciat la sessió, enganxa el codi aquí.",
  "settings.signIn.linkNotOpen": "No s'ha obert l'enllaç?",
  "settings.signIn.linkCopied": "Enllaç copiat",
  "settings.signIn.copyLink": "Copia l'enllaç d'inici de sessió",
  "settings.signIn.enterCode":
    "Escriu aquest codi d'un sol ús a la pàgina d'OpenAI:",
  "settings.signIn.signOutDialog": "Tanca la sessió de {provider}",
  "settings.signIn.signingOut": "Tancant la sessió…",
  "settings.signIn.confirmSignOut": "Confirma el tancament de sessió",
  "settings.signIn.connectedStart":
    "Connectat. Comença una conversa nova per fer servir aquest compte.",
  "settings.signIn.startConversation": "Comença una conversa nova",

  "settings.env.loadFailed": "No s'han pogut carregar les variables",
  "settings.env.saveFailed": "No s'han pogut desar les variables",
  "settings.env.loadingVariables": "Carregant les variables…",
  "settings.env.variableName": "Nom de la variable",
  "settings.env.valueLabel": "Valor de {name}",
  "settings.env.variable": "Variable",
  "settings.env.valuePlaceholder": "Valor",
  "settings.env.remove": "Treu",
  "settings.env.add": "Afegeix una variable",
  "settings.env.hideValues": "Amaga els valors",
  "settings.env.showValues": "Mostra els valors",
  "settings.env.save": "Desa les variables",
  "settings.env.saved": "Variables desades",
  "settings.env.duplicate": "Els noms de les variables no es poden repetir.",

  "settings.memberConnections.title": "Connexions individuals",
  "settings.memberConnections.hint":
    "Variables que aquesta persona ha posat per als seus propis agents. Només els noms - els valors queden privats.",
  "settings.memberConnections.loadFailed":
    "No s'han pogut carregar les variables.",
  "settings.memberConnections.empty": "No hi ha variables.",
  "dialogs.textarea.expand": "Amplia {title}",
  "dialogs.textarea.escCollapse": "Esc per plegar",
  "dialogs.textarea.done": "Fet",

  "dialogs.schedulePrompt.title": "Configuració de les programacions",
  "dialogs.schedulePrompt.rulesHint":
    "(prompt de sistema per a totes les programacions)",
  "dialogs.schedulePrompt.rulesPlaceholder":
    "p. ex. Escriu sempre les troballes en un fitxer markdown. Sigues concís.",
  "dialogs.schedulePrompt.appliedNextRun":
    "S'aplica a l'execució següent; les que ja s'estan executant fan servir la còpia que van capturar.",
  "common.field.engine": "Motor",
  "common.field.model": "Model",
  "common.field.effort": "Esforç de raonament",
  "common.field.sandbox": "Sandbox",
  "common.field.permissionMode": "Mode de permisos",
  "common.field.approvalPolicy": "Política d'aprovació",
  "common.field.workingDirectory": "Directori de treball",

  "common.effort.minimal": "Mínim (només Codex)",
  "common.effort.low": "Baix",
  "common.effort.medium": "Mitjà",
  "common.effort.high": "Alt",
  "common.effort.xhigh": "Molt alt",
  "common.effort.max": "Màxim",
  "common.effort.ultra": "Ultra (només Codex)",

  "common.permission.claudeBypass":
    "Ometre els permisos (s'aprova tot automàticament)",
  "common.permission.codexNever": "No preguntar mai (només el sandbox)",
  "common.sandbox.readOnly":
    "Només lectura (el model pot llegir, mai escriure)",
  "common.sandbox.workspaceWrite":
    "Escriptura a l'espai de treball (només dins del cwd)",
  "common.sandbox.dangerFullAccess": "Perill: accés total (sense sandbox)",

  "common.model.currentOption": "Model actual",
  "common.model.currentIs": "Model actual: {model}.",
  "common.model.checkFailed":
    "No s'han pogut comprovar els models disponibles. Torna a obrir aquest diàleg per provar-ho de nou.",
  "common.model.notOffered":
    "Aquest compte no l'ofereix. Tria un model disponible.",
  "common.model.loading": "Carregant els models disponibles…",
  "common.model.startingOpenCode":
    "OpenCode s'està iniciant. Carregant els models disponibles…",
  "common.model.noneConnected":
    "OpenCode no té models de cap proveïdor connectat per a aquest entorn.",
  "common.model.selectConnected":
    "Tria un model d'OpenCode connectat abans de desar.",
  "common.model.loadFailed": "No s'han pogut carregar els models",
  "common.model.openCodeListFailed":
    "OpenCode no ha pogut llistar els seus models. Torna a obrir aquest diàleg.",
  "common.model.codexNotSignedIn":
    "No has iniciat la sessió a Codex. Obre un agent de Codex i fes clic a la targeta d'inici de sessió que emet, i després torna a obrir aquest diàleg. (O defineix OPENAI_API_KEY al teu entorn.)",
  "common.model.openCodeLoadFailed":
    "No s'han pogut carregar els models d'OpenCode{detail}. Torna a obrir aquest diàleg per provar-ho de nou.",
  "common.model.listLoadFailed":
    "No s'ha pogut carregar la llista de models{detail}. Es mostra la llista de reserva - pot ser que algunes opcions no funcionin al teu compte.",

  "dialogs.schedule.titleNew": "Programació nova",
  "dialogs.schedule.titleEdit": "Editar la programació",
  "dialogs.schedule.namePlaceholder": "Resum diari",
  "dialogs.schedule.daily": "Cada dia",
  "dialogs.schedule.weekly": "Cada setmana",
  "dialogs.schedule.interval": "Cada N minuts",
  "dialogs.schedule.weekday.sunday": "Diumenge",
  "dialogs.schedule.weekday.monday": "Dilluns",
  "dialogs.schedule.weekday.tuesday": "Dimarts",
  "dialogs.schedule.weekday.wednesday": "Dimecres",
  "dialogs.schedule.weekday.thursday": "Dijous",
  "dialogs.schedule.weekday.friday": "Divendres",
  "dialogs.schedule.weekday.saturday": "Dissabte",
  "dialogs.schedule.hour": "Hora (0-23)",
  "dialogs.schedule.minute": "Minut (0-59)",
  "dialogs.schedule.intervalMinutes": "Interval (minuts, mínim 5)",
  "dialogs.schedule.serverLocal": "Les hores són les del servidor.",
  "dialogs.schedule.prompt": "Prompt",
  "dialogs.schedule.promptTitle": "Prompt de la programació",
  "dialogs.schedule.promptPlaceholder":
    'p. ex. "Resumeix què va aconseguir ahir cada agent."',
  "dialogs.schedule.promptEmpty": "El prompt no pot estar buit.",
  "dialogs.schedule.permissionUnattended":
    "Permetre les eines del projecte (sense supervisió)",
  "dialogs.schedule.permissionHintOpenCode":
    "Es permeten les eines de shell i d'edició. Es deneguen la delegació i les preguntes.",
  "dialogs.schedule.permissionHint":
    "Les programacions s'executen sense supervisió - els modes que demanen aprovació humana no estan disponibles.",
  "dialogs.schedule.enabled":
    "Activada (desmarca-la per posar-la en pausa sense eliminar-la)",
  "dialogs.schedule.create": "Crea",

  "dialogs.agent.titleSpawn": "Crear un agent nou",
  "dialogs.agent.titleEdit": "Editar l'agent",
  "dialogs.agent.desk": "Escriptori #{desk}",
  "dialogs.agent.engineBlurb.claude":
    "Funciona amb el teu compte de Claude Code.",
  "dialogs.agent.engineBlurb.codex": "Funciona amb el teu compte de ChatGPT.",
  "dialogs.agent.engineBlurb.opencode":
    "Funciona amb els models configurats a través d'OpenCode.",
  "dialogs.agent.engineSwitchHint":
    "Canviar a {engine} comença una conversa nova. L'actual es queda a l'historial de sessions d'aquest agent.",
  "dialogs.agent.template": "Començar amb una plantilla",
  "dialogs.agent.templateHint":
    "Les plantilles omplen els camps de sota. Pots editar totes les propostes.",
  "dialogs.agent.blank": "En blanc",
  "dialogs.agent.blankHint": "Configura l'agent tu mateix.",
  "dialogs.agent.appearance": "Aspecte",
  "dialogs.agent.randomize": "Tria a l'atzar",
  "dialogs.agent.skin": "Pell",
  "dialogs.agent.shirt": "Samarreta",
  "dialogs.agent.hairColor": "Color del cabell",
  "dialogs.agent.hairStyle": "Pentinat",
  "dialogs.agent.hat": "Barret",
  "dialogs.agent.beard": "Barba",
  "dialogs.agent.accessory": "Accessori",
  "dialogs.agent.hairStyle.short": "Curt",
  "dialogs.agent.hairStyle.long": "Llarg",
  "dialogs.agent.hairStyle.ponytail": "Cua",
  "dialogs.agent.hairStyle.bun": "Monyo",
  "dialogs.agent.hairStyle.pigtails": "Cues",
  "dialogs.agent.hairStyle.curly": "Arrissat",
  "dialogs.agent.hairStyle.bald": "Calb",
  "dialogs.agent.hat.none": "Cap",
  "dialogs.agent.hat.cap": "Gorra",
  "dialogs.agent.hat.beanie": "Gorro de llana",
  "dialogs.agent.hat.bow": "Llaç",
  "dialogs.agent.hat.headband": "Cinta",
  "dialogs.agent.accessory.none": "Cap",
  "dialogs.agent.accessory.glasses": "Ulleres",
  "dialogs.agent.accessory.headphones": "Auriculars",
  "dialogs.agent.accessory.bowTie": "Corbatí",
  "dialogs.agent.accessory.tie": "Corbata",
  "dialogs.agent.accessory.earrings": "Arracades",
  "dialogs.agent.beard.none": "Cap",
  "dialogs.agent.beard.stubble": "Incipient",
  "dialogs.agent.beard.full": "Poblada",
  "dialogs.agent.beard.goatee": "Perilla",
  "dialogs.agent.beard.mustache": "Bigoti",
  "dialogs.agent.recent": "Recents",
  "dialogs.agent.manager": "Responsable",
  "dialogs.agent.managerTitle":
    "Es fixa en crear l'agent - el responsable no es pot canviar després.",
  "dialogs.agent.managerNoUser": "(cap usuari assignat)",
  "dialogs.agent.managerUnowned": "(sense propietari)",
  "dialogs.agent.managerHint":
    "Vinculat a l'usuari que el crea. Determina quines variables personals es carreguen a cada sessió (mira Configuració → Tu → Connexions individuals).",
  "dialogs.agent.privileged": "Accés d'operador amb privilegis",
  "dialogs.agent.privilegedHint":
    "Permet a aquest agent dirigir les sessions d'altres agents (reprendre, conversa nova, enviar ara) i gestionar els seus propis cronjobs, amb els permisos per sala de l'usuari que el va crear. Continua actuant com l'agent, mai com l'usuari.",
  "dialogs.agent.privilegedRestart":
    "En desar es reinicia la sessió de l'agent.",
  "dialogs.agent.permission.ask": "Preguntar",
  "dialogs.agent.permission.bypassAll": "Ometre tots els permisos",
  "dialogs.agent.permission.codexUntrusted":
    "No fiable (preguntar a cada eina)",
  "dialogs.agent.permission.codexOnRequest":
    "A petició (el model pregunta quan ho necessita)",
  "dialogs.agent.permission.claudeAuto":
    "Auto (un classificador aprova les accions segures)",
  "dialogs.agent.permission.claudeDefault": "Per defecte (preguntar per a tot)",
  "dialogs.agent.permission.claudeAcceptEdits":
    "Acceptar les edicions (aprovar els canvis en fitxers)",
  "dialogs.agent.modelTier.free":
    "Gratis (el proveïdor pot fer servir el trànsit per entrenar)",
  "dialogs.agent.modelTier.payg": "Pagament per ús (crèdits d'OpenCode)",
  "dialogs.agent.modelTier.subscription": "Subscripció (OpenCode Go)",
  "dialogs.agent.memoryHint":
    "(fets duradors d'aquest agent; línies en brut; {size} / {cap})",
  "dialogs.agent.memoryTitle": "Memòria de l'agent",
  "dialogs.agent.memoryPlaceholder":
    "Alguna memòria rellevant per a aquest agent",
  "dialogs.agent.customInstructions": "Instruccions personalitzades",
  "dialogs.agent.optional": "(opcional)",
  "dialogs.agent.customInstructionsHint":
    "Prompt de sistema personal per a aquest agent. Executa /isomux-system-prompt en un xat per veure el prompt de sistema complet de l'agent.",
  "dialogs.agent.customInstructionsPlaceholder":
    'p. ex. "Ets un especialista en backend. Escriu sempre tests."',
  "dialogs.agent.systemPromptHint":
    "Executa <code>/isomux-system-prompt</code> en un xat per veure el prompt de sistema complet de l'agent.",
  "dialogs.agent.revive": "Reactiva un agent aturat",
  "dialogs.agent.reviving": "Reactivant…",
  "dialogs.agent.reviveFailed": "No s'ha pogut reactivar",
  "dialogs.agent.moveToRoom": "Moure a la sala",
  "dialogs.agent.invalidDirectory": "Directori no vàlid",
  "dialogs.agent.staleInstructions":
    "Les instruccions personalitzades han canviat des que vas obrir això - torna a obrir el diàleg per editar la versió més recent.",
  "dialogs.agent.spawn": "Crea",

  "templates.moneyPlanner.label": "Planificador de finances",
  "templates.moneyPlanner.description":
    "Planifica despeses, estalvi, objectius i decisions financeres.",
  "templates.sideProjectBuilder.label": "Creador de projectes paral·lels",
  "templates.sideProjectBuilder.description":
    "Converteix una idea vaga en un producte petit que arriba a publicar-se.",
  "templates.healthNavigator.label": "Guia de salut",
  "templates.healthNavigator.description":
    "Organitza la informació de salut i prepara les consultes.",
  "templates.lifeCoach.label": "Coach de vida",
  "templates.lifeCoach.description":
    "Aclareix objectius, tria els passos següents i revisa el progrés.",
  "templates.researchAnalyst.label": "Analista de recerca",
  "templates.researchAnalyst.description":
    "Investiga preguntes i produeix informes a punt per decidir.",
  "templates.personalSiteBuilder.label": "Creador de llocs personals",
  "templates.personalSiteBuilder.description":
    "Dissenya, construeix i publica un lloc web personal.",
  "templates.cityGuide.label": "Guia de la ciutat",
  "templates.cityGuide.description":
    "Descobreix llocs i planifica segons com explores.",
  "templates.todoListAssistant.label": "Assistent de tasques pendents",
  "templates.todoListAssistant.description":
    "Converteix els compromisos en un sistema personal que continua sent útil.",
  "templates.codeReviewer.label": "Revisor de codi",
  "templates.codeReviewer.description":
    "Troba els defectes que importen i explica solucions precises.",
  "templates.relationshipAdvisor.label": "Conseller de relacions",
  "templates.relationshipAdvisor.description":
    "Pensa a fons la comunicació, les necessitats i els passos següents.",
  "templates.jobSearchCoach.label": "Coach de cerca de feina",
  "templates.jobSearchCoach.description":
    "Enfoca la cerca i millora les candidatures i les entrevistes.",
  "templates.tripPlanner.label": "Planificador de viatges",
  "templates.tripPlanner.description":
    "Construeix viatges pràctics segons els teus interessos i els teus límits.",
  // The API-call card (S5): what an agent's curl against the isomux API
  // did, in one line. A route's static label and the parameter-aware
  // sentence for the same call share a key when their English matches.
  "apiCall.tasks.list": "Llistar tasques",
  "apiCall.tasks.create": "Crear tasca",
  "apiCall.tasks.claim": "Reclamar tasca",
  "apiCall.tasks.complete": "Completar tasca",
  "apiCall.tasks.update": "Actualitzar tasca",
  "apiCall.tasks.delete": "Eliminar tasca",
  "apiCall.tasks.listOpen": "Llistar tasques obertes",
  "apiCall.tasks.listOpenGlobal":
    "Llistar tasques obertes (només les globals de l'oficina)",
  "apiCall.tasks.listOpenInRoom": "Llistar tasques obertes d'una sala",
  "apiCall.tasks.listAll": "Llistar totes les tasques",
  "apiCall.tasks.listAllGlobal":
    "Llistar totes les tasques (només les globals de l'oficina)",
  "apiCall.tasks.listAllInRoom": "Llistar totes les tasques d'una sala",
  "apiCall.tasks.listStatus": "Llistar tasques amb estat {status}",
  "apiCall.tasks.listStatusGlobal":
    "Llistar tasques amb estat {status} (només les globals de l'oficina)",
  "apiCall.tasks.listStatusInRoom":
    "Llistar tasques amb estat {status} d'una sala",
  "apiCall.tasks.createTitled": "Crear tasca: {title}",
  "apiCall.tasks.createPlain": "Crear una tasca",
  "apiCall.tasks.updateOne": "Actualitzar la tasca {task}",
  "apiCall.tasks.deleteOne": "Eliminar la tasca {task}",
  "apiCall.tasks.readOne": "Llegir la tasca {task}",
  "apiCall.tasks.claimFor": "Reclamar la tasca {task} per a {assignee}",
  "apiCall.tasks.claimOne": "Reclamar la tasca {task}",
  "apiCall.tasks.markDone": "Marcar la tasca {task} com a feta",
  "apiCall.agents.list": "Llistar els agents de l'oficina",
  "apiCall.agents.listKilled": "Llistar els agents eliminats",
  "apiCall.agents.listInvalidFilter":
    "Llistar agents (filtre d'eliminats no vàlid)",
  "apiCall.agents.sendMessage": "Enviar un missatge a un agent",
  "apiCall.agents.sendMessageTo": "Enviar un missatge a {who}",
  "apiCall.agents.steerMessage": "Interrompre {who} amb un missatge",
  "apiCall.agents.scheduleMessage": "Programar un missatge per a {who}",
  "apiCall.agents.spawn": "Crear un agent nou",
  "apiCall.agents.spawnNamed": "Crear l'agent {name}",
  "apiCall.agents.editSettings": "Editar la configuració de {who}",
  "apiCall.agents.remove": "Eliminar l'agent {who}",
  "apiCall.agents.handoff": "Traspassar a una sessió nova",
  "apiCall.agents.handoffFor": "Traspassar {who} a una sessió nova",
  "apiCall.agents.scheduledList": "Llistar els missatges programats",
  "apiCall.agents.scheduledListFor":
    "Llistar els missatges programats que {who} té per enviar",
  "apiCall.agents.scheduledCancel": "Cancel·lar un missatge programat",
  "apiCall.agents.scheduledCancelFor":
    "Cancel·lar un dels missatges programats de {who}",
  "apiCall.agents.shareFile": "Compartir un fitxer al xat",
  "apiCall.agents.shareFileDetail": "Compartir un fitxer al xat",
  "apiCall.agents.previewUrl": "Capturar una pàgina al xat",
  "apiCall.agents.previewUrlDetail": "Capturar una pàgina al xat",
  "apiCall.agents.showDiff": "Mostrar un diff al xat",
  "apiCall.agents.showDiffDetail": "Mostrar un diff al xat",
  "apiCall.agents.offerFile": "Oferir un fitxer a l'editor",
  "apiCall.agents.offerFileDetail": "Oferir un fitxer a l'editor",
  "apiCall.agents.suggestCommand": "Suggerir una ordre de terminal",
  "apiCall.agents.suggestCommandDetail": "Suggerir una ordre de terminal",
  "apiCall.agents.context": "Consultar l'ús del context",
  "apiCall.agents.logsSearch": "Cercar als registres de conversa",
  "apiCall.agents.logsSearchFor": 'Cercar "{query}" als registres de {who}',
  "apiCall.agents.logsAround":
    "Llegir al voltant d'una entrada als registres de {who}",
  "apiCall.agents.logsSession": "Llegir una sessió dels registres de {who}",
  "apiCall.agents.logsList": "Llistar les sessions dels registres de {who}",
  "apiCall.agents.instructions": "Llegir les instruccions de l'agent",
  "apiCall.agents.clearConversation": "Esborrar la conversa de {who}",
  "apiCall.agents.flushQueue": "Buidar ara la cua de {who}",
  "apiCall.agents.interrupt": "Interrompre {who}",
  "apiCall.agents.resume": "Reprendre una sessió de {who}",
  "apiCall.agents.sessions": "Llistar les sessions de {who}",
  "apiCall.agents.move": "Moure {who}",
  "apiCall.agents.revive": "Reviure {who}",
  "apiCall.agents.cancelQueued": "Cancel·lar un missatge en cua per a {who}",
  "apiCall.agents.editMessage": "Editar un missatge del xat de {who}",
  "apiCall.apiTokens.list": "Llistar els tokens d'API",
  "apiCall.apiTokens.create": "Crear un token d'API",
  "apiCall.apiTokens.revoke": "Revocar un token d'API",
  "apiCall.providerAccounts.check": "Consultar els comptes de proveïdor",
  "apiCall.providerAccounts.signInStart":
    "Començar l'inici de sessió amb el proveïdor",
  "apiCall.providerAccounts.signInCancel":
    "Cancel·lar l'inici de sessió amb el proveïdor",
  "apiCall.providerAccounts.signOut":
    "Tancar la sessió del compte de proveïdor",
  "apiCall.providerAccounts.refresh": "Actualitzar els comptes de proveïdor",
  "apiCall.providerAccounts.signInCode":
    "Enviar el codi d'inici de sessió del proveïdor",
  "apiCall.env.readUser": "Llegir l'entorn gestionat",
  "apiCall.env.saveUser": "Desar l'entorn gestionat",
  "apiCall.env.readOffice": "Llegir l'entorn de l'oficina",
  "apiCall.env.saveOffice": "Desar l'entorn de l'oficina",
  "apiCall.inbox.messageBoss": "Enviar un missatge al cap remot",
  "apiCall.inbox.drain": "Buidar la safata del token d'API",
  "apiCall.memory.read": "Llegir la memòria",
  "apiCall.memory.append": "Afegir a la memòria",
  "apiCall.memory.replace": "Reemplaçar la memòria",
  "apiCall.memory.readAgent": "Llegir les memòries d'aquest agent",
  "apiCall.memory.readRoom": "Llegir les memòries de la sala",
  "apiCall.memory.readOffice": "Llegir les memòries de l'oficina",
  "apiCall.memory.readBoss": "Llegir les memòries del cap",
  "apiCall.memory.readAny": "Llegir les memòries",
  "apiCall.memory.saveAgent": "Desar una memòria per a aquest agent",
  "apiCall.memory.saveRoom": "Desar una memòria de sala",
  "apiCall.memory.saveOffice": "Desar una memòria d'oficina",
  "apiCall.memory.saveBoss": "Desar una memòria de cap",
  "apiCall.memory.save": "Desar una memòria",
  "apiCall.memory.rewriteAgent": "Reescriure les memòries d'aquest agent",
  "apiCall.memory.rewriteRoom": "Reescriure les memòries de la sala",
  "apiCall.memory.rewriteOffice": "Reescriure les memòries de l'oficina",
  "apiCall.memory.rewriteBoss": "Reescriure les memòries del cap",
  "apiCall.memory.rewriteAny": "Reescriure les memòries",
  "apiCall.rooms.create": "Crear una sala",
  "apiCall.rooms.createNamed": "Crear la sala {name}",
  "apiCall.rooms.rename": "Reanomenar la sala com a {name}",
  "apiCall.rooms.setPet": "Posar la mascota d'una sala",
  "apiCall.rooms.update": "Actualitzar una sala",
  "apiCall.rooms.close": "Tancar una sala",
  "apiCall.rooms.updateSettings": "Actualitzar la configuració de la sala",
  "apiCall.rooms.swapDesks": "Intercanviar escriptoris en una sala",
  "apiCall.cronjobs.list": "Llistar les programacions",
  "apiCall.cronjobs.create": "Crear una programació",
  "apiCall.cronjobs.read": "Llegir una programació",
  "apiCall.cronjobs.update": "Actualitzar una programació",
  "apiCall.cronjobs.delete": "Eliminar una programació",
  "apiCall.cronjobs.listRuns": "Llistar les execucions d'una programació",
  "apiCall.cronjobs.triggerRun": "Llançar una execució de la programació",
  "apiCall.cronjobs.readRun": "Llegir una execució de la programació",
  "apiCall.cronjobs.listRecentRuns": "Llistar les execucions recents",
  "apiCall.apps.list": "Llistar les apps",
  "apiCall.apps.register": "Registrar una app",
  "apiCall.apps.read": "Llegir una app",
  "apiCall.apps.preview": "Capturar la vista prèvia de l'app",
  "apiCall.apps.update": "Actualitzar l'app",
  "apiCall.apps.delete": "Eliminar l'app",
  "apiCall.apps.logs": "Llegir els registres de l'app",
  "apiCall.apps.start": "Arrencar l'app",
  "apiCall.apps.stop": "Aturar l'app",
  "apiCall.apps.restart": "Reiniciar l'app",
  "apiCall.skillUsage.read": "Llegir el recompte d'ús d'habilitats",
  "apiCall.version.check": "Consultar la versió d'isomux",
  "apiCall.storage.usage": "Consultar l'ús de disc de l'oficina",
  "apiCall.storage.prune": "Purgar l'historial emmagatzemat",
  "apiCall.usage.tokens": "Consultar l'ús de tokens de l'oficina",
  "apiCall.body.jq": "cos construït amb jq",
  "apiCall.body.jqReads": "cos construït amb jq (llegeix {files})",
  "apiCall.body.heredoc": "cos des d'un heredoc",
  "apiCall.body.output": "sortida desada a {file}",
  "apiCall.body.outputAppended": "sortida afegida a {file}",
  "apiCall.body.more": "+{count} més",
  "common.copiedNotice": "Copiat!",
  "common.tasks": "Tasques",
  "common.avatar": "Avatar",
  "common.agent": "Agent",
  "common.dismiss": "Amaga",
  "common.you": "Tu",
  "common.send": "Envia",
  "common.modified": "modificat",
  "common.terminal": "Terminal",
  "common.days.other": "{count} dies",
  "common.days.one": "{count} dia",
  "common.sender.agent": "{name} · agent",
  "common.sender.agentInRoom": '{name} · agent · Sala "{room}"',
  "common.sender.app": "{name} · app",
  "common.sender.cronjob": "{name} · programació",
  "cards.userMessage.toRemoteBoss": "Al cap remot",
  "cards.userMessage.toRemoteBossNamed": 'Al cap remot "{name}"',
  "cards.userMessage.editAndBranch": "Edita i ramifica",
  "cards.thinking.label": "Pensant...",
  "cards.toolCall.input": "Entrada",
  "cards.toolCall.output": "Sortida",
  "cards.toolCall.denied": "Denegat",
  "cards.toolCall.groupCount": "{count} crides a eines",
  "cards.toolResult.showMore": "Mostra'n més",
  "cards.toolResult.showLess": "Mostra'n menys",
  "cards.fileView.fullSize": "Mida completa",
  "cards.fileView.earlierAttachment":
    "L'agent ha vist un fitxer adjuntat abans en aquest xat. Fes clic per mostrar-lo.",
  "cards.editRequest.open": "Obre a l'editor",
  "cards.editRequest.openHint": "Obre {path} al plafó lateral de l'editor",
  "cards.terminalCommand.copy": "Copia a la terminal",
  "cards.tool.noOutput": "(sense sortida)",
  "cards.tool.morePaths": "{path} +{count} més",
  "cards.terminalCommand.copyHint":
    "Obre el plafó de la terminal i escriu aquesta ordre al prompt (no s'executa sola)",
  "cards.markdown.mermaidError": "Error de Mermaid",
  "cards.markdown.mermaidLoadFailed": "No s'ha pogut carregar mermaid",
  "cards.diff.status.added": "afegit",
  "cards.diff.status.deleted": "eliminat",
  "cards.diff.status.renamed": "reanomenat",
  "cards.diff.status.copied": "copiat",
  "cards.diff.status.untracked": "sense seguiment",
  "cards.diff.status.binary": "binari",
  "cards.diff.reasonTruncated":
    "El pedaç total passava de 2 MB, així que el contingut del diff no s'ha enviat al navegador. Torna a executar /isomux-diff amb menys fitxers a l'arbre de treball, o obre aquest fitxer al teu editor.",
  "cards.diff.reasonBinary":
    "Fitxer binari - no hi ha cap diff de text per mostrar.",
  "cards.diff.reasonUntracked":
    "Fitxer sense seguiment massa gran per sintetitzar un pedaç (>1 MB). Obre'l al teu editor, o fes-hi `git add` i torna-ho a executar.",
  "cards.diff.reasonNoPatch":
    "No hi ha contingut de pedaç per a aquest fitxer.",
  "cards.diff.closeHint": "Tanca (Esc)",
  "cards.diff.openTruncated": "Obre (pedaç no enviat)",
  "cards.diff.openBinary": "Obre (binari)",
  "cards.diff.openUntracked": "Obre (sense seguiment, massa gran)",
  "cards.diff.openLines": "Obre ({lines} línies)",
  "cards.diff.unified": "Unificat",
  "cards.diff.split": "Dividit",
  "cards.diff.collapseAll": "Plega-ho tot",
  "cards.diff.expandAll": "Desplega-ho tot",
  "cards.diff.summaryOnly": "· pedaç > 2 MB · només el resum",
  "cards.diff.headerLine": "+{additions} -{deletions} en {files}",
  "cards.diff.fileCount.one": "{count} fitxer",
  "cards.diff.fileCount.other": "{count} fitxers",
  "contextBattery.detail":
    "Context: {tokens} / {maxTokens} tokens utilitzats (en queda un {remaining}%).",
  "contextBattery.nudge":
    "Pots demanar a l'agent que tanqui la feina, o fer servir /clear per començar una sessió nova.",
  "contextBattery.unknown":
    "L'ús del context encara no s'ha mesurat. S'actualitza quan l'agent acaba un torn.",
  "contextBattery.ariaKnown":
    "Bateria de context: en queda un {remaining}%. Toca per veure'n els detalls.",
  "contextBattery.ariaUnknown":
    "L'ús del context encara no s'ha mesurat. Toca per veure'n els detalls.",
  "logView.state.thinking": "Pensant",
  "logView.state.toolExecuting": "Executant una eina",
  "logView.pendingPrompt.permission": "Esperant un permís",
  "logView.pendingPrompt.resume": "Esperant que triïs una sessió",
  "logView.pendingPrompt.model": "Esperant que triïs un model",
  "logView.pendingPrompt.effort": "Esperant que triïs un esforç",
  "logView.abort": "Avorta",
  "logView.restartingSession": "Reiniciant la sessió...",
  "logView.queue.flushNow": "Envia ara",
  "logView.queue.flushHint":
    "Envia ara els missatges en cua (interromp el torn actual)",
  "logView.queue.cancel": "Cancel·la aquest missatge en cua",
  "logView.interaction.current": "Actual",
  "logView.interaction.failed": "No s'ha pogut aplicar aquesta opció.",
  "logView.nav.agentTitle": "Configuració de l'agent",
  "logView.nav.avatarTitle": "Mostra l'avatar",
  "logView.nav.editor": "Editor",
  "logView.nav.editorTitle": "Obre l'editor de fitxers (Ctrl+E)",
  "logView.nav.terminalTitle": "Obre la terminal (Ctrl+`)",
  "logView.backToOffice": "← Torna a l'oficina",
  "logView.editTopic": "Fes clic per editar el tema",
  "logView.regenerateTopic": "Regenera el tema a partir de la conversa",
  "logView.noHistoryToSummarize": "No hi ha historial de conversa per resumir",
  "logView.lastMessagePrefix": "↑ tu:",
  "logView.empty": "Envia un missatge per començar una conversa.",
  "logView.sendFailedBanner":
    "No s'ha pogut enviar - reconnectant. El teu missatge continua a la caixa; torna-ho a provar quan desaparegui aquest avís.",
  "logView.attachTooLarge": "Fitxer massa gran (màxim 200MB)",
  "logView.attachUploading": "pujant…",
  "logView.attachFiles": "Adjunta fitxers",
  "logView.scrollToBottom": "Ves al final",
  "logView.composer.type": "Escriu un missatge o / per a les ordres...",
  "logView.composer.typeShort": "Escriu un missatge...",
  "logView.composer.queueShort": "Escriu per posar en cua...",
  "logView.composer.queueLong":
    "Escriu per posar en cua - s'envia quan acabi el torn actual · {modifier}Enter per enviar-lo ara",
  "logView.composer.editing": "Editant el missatge de dalt...",
  "logView.composer.queue": "Posa el missatge en cua",
  "logView.cite.label": "Cita",
  "logView.cite.hint": "Cita el text seleccionat al missatge",
  "logView.skills.title": "Habilitats i ordres",
  "logView.skills.buttonLabel": "Ha",
  "logView.uploadFailed": "Error en pujar ({status})",
  "logView.skills.filter": "Filtra habilitats i ordres...",
  "logView.skills.noMatch": "No hi ha habilitats ni ordres que coincideixin",
  "logView.skills.group.mostUsed": "Més usats",
  "logView.skills.group.commands": "Ordres",
  "logView.skills.group.bundled": "Inclosos",
  "logView.skills.group.project": "Projecte",
  "logView.skills.group.plugin": "Plugin",
  "logView.skills.origin.user": "habilitat d'usuari",
  "logView.skills.origin.project": "habilitat de projecte",
  "logView.skills.origin.plugin": "habilitat de plugin",
  "logView.skills.origin.isomux": "habilitat inclosa a isomux",
  "logView.skills.origin.claude": "habilitat de claude",
  "logView.skills.origin.unknown": "habilitat",
  "logView.voice.talkHint": "Fes clic per parlar (Ctrl+Espai per mantenir)",
  "logView.voice.blocked":
    "L'entrada de veu està bloquejada. Revisa el permís del micròfon per a aquest lloc al teu navegador.",
  "logView.voice.noMicrophone": "No s'ha trobat cap micròfon.",
  "logView.voice.network":
    "L'entrada de veu no ha pogut connectar amb el servei de veu.",
  "logView.voice.failed": "L'entrada de veu ha fallat.",
  "logView.voice.speak": "Llegeix en veu alta",
  "logView.voice.stop": "Atura",
  "logView.voice.noVoice":
    "No hi ha cap veu en {language} instal·lada en aquest dispositiu",
  "logView.voice.language.en": "anglès",
  "logView.voice.language.es": "espanyol",
  "logView.voice.language.ca": "català",
  "logView.voice.httpsTitle": "L'entrada de veu necessita HTTPS",
  "logView.voice.httpsStep1":
    "Activa HTTPS a la teva <console>consola d'administració de Tailscale</console> (pàgina DNS), i després executa això a l'amfitrió (fes servir la terminal integrada):",
  "logView.voice.httpsStep2":
    "Visita l'URL HTTPS que imprimeix Tailscale (p. ex. <url>{example}</url>).",
  "panels.resizer.label": "Canvia l'amplada del plafó lateral",
  "panels.terminal.ready": "Llesta",
  "panels.terminal.busy": "Ocupada: {process}",
  "panels.terminal.interrupt": "Interromp",
  "panels.terminal.interruptHint": "Interromp l'ordre en primer pla",
  "panels.terminal.restart": "Reinicia",
  "panels.terminal.restartHint": "Reinicia la terminal",
  "panels.terminal.close": "Tanca la terminal",
  "panels.terminal.sendToChat": "Envia al xat",
  "panels.terminal.sendToChatHint":
    "Insereix el text seleccionat al xat com a bloc de codi",
  "panels.terminal.shellExited": "La shell ha acabat ({code})",
  "panels.terminal.unavailable": "Terminal no disponible",
  "panels.terminal.busyIssue":
    "No s'ha enviat: {process} està usant la terminal",
  "panels.terminal.paste": "Enganxa",
  "panels.terminal.pastePrompt": "Enganxa:",
  "panels.editor.close": "Tanca l'editor",
  "panels.editor.closeTab": "Tanca la pestanya",
  "panels.editor.selectFile": "Tria un fitxer",
  "panels.editor.saveHint": "Ctrl+S per desar",
  "panels.editor.saved": "desat",
  "panels.editor.recentlyOpened": "Oberts recentment",
  "panels.editor.staleBanner":
    "El fitxer ha canviat al disc des que el vas obrir. Si el tornes a carregar, perdràs els teus canvis.",
  "panels.editor.externalBanner":
    "El fitxer ha canviat per fora - perdràs els teus canvis si el tornes a carregar.",
  "panels.editor.deletedBanner":
    "El fitxer s'ha eliminat del disc. Si el deses, es tornarà a crear a partir d'aquest búfer.",
  "panels.editor.overwrite": "Sobreescriu",
  "panels.editor.reload": "Torna a carregar",
  "panels.editor.saveToRecreate": "Desa per tornar-lo a crear",
  "panels.editor.saveFailed": "No s'ha pogut desar: {reason}",
  "panels.editor.saveError": "no s'ha pogut desar",
  "panels.editor.openError": "{path}: {reason}",
  "panels.editor.openFailed": "no s'ha pogut obrir",
  "subscription.plan": "Pla: {plan}",
  "subscription.caveat": "Això és de tot el compte, no de cada agent.",
  "subscription.chooserHint": "Quin límit segueix el número:",
  "subscription.autoChoice": "Automàtic (el més ajustat)",
  "subscription.unknown":
    "L'ús del pla encara no s'ha informat. S'actualitza quan l'agent acaba un torn - les sessions sense límits de pla (clau d'API, Bedrock, Vertex) no n'informen de cap.",
  "subscription.readingAge": "Lectura presa fa {age}.",
  "subscription.ariaTracked":
    "Quota del pla {label}: usat un {used}%. Toca per veure'n els detalls.",
  "subscription.ariaTrackedPinned":
    "Quota del pla {label}: usat un {used}%, fixat. Toca per veure'n els detalls.",
  "subscription.ariaUnknown":
    "L'ús del pla encara no s'ha informat. Toca per veure'n els detalls.",
  "subscription.window.used": "{label}: usat un {percent}%",
  "subscription.window.usedResets":
    "{label}: usat un {percent}% - es reinicia el {at}",
  "subscription.window.usedResetsIn":
    "{label}: usat un {percent}% - es reinicia el {at} (d'aquí a {duration})",
  "subscription.duration.hours.one": "{count} hora",
  "subscription.duration.hours.other": "{count} hores",
  "subscription.duration.minutes": "{count} min",
  "subscription.duration.daysHours": "{days} i {hours}",
  "subscription.duration.hoursMinutes": "{hours} i {minutes}",
  "logView.editAgent": "Edita l'agent",
  "panels.editor.noFileOpen": "Cap fitxer obert",
  "panels.editor.emptyHint":
    "Cap fitxer obert. Fes servir <code>{command}</code> o demana a l'agent que te'n enviï un.",
  "logView.queue.count": "{count} en cua",
  "logView.queue.chip": "en cua · {label}",
  "logView.queue.attachments.one": "{count} adjunt",
  "logView.queue.attachments.other": "{count} adjunts",
  "logView.backendTitle": "Motor: {backend}",
  "cards.markdown.rendering": "Dibuixant el diagrama…",
  "cards.subagent.pill": "subagent",
  "cards.subagent.pillTyped": "subagent · {type}",
  "cards.subagent.title": "Subagent",
  "cards.subagent.titleTyped": "Subagent ({type})",
  "cards.subagent.titleDescribed": "Subagent: {description}",
  "cards.subagent.titleTypedDescribed": "Subagent ({type}): {description}",
  "cards.fileView.viewedFile": "Ha vist {file} (fes clic per mostrar-lo)",
  "cards.fileView.viewedImages":
    "Ha vist {count} imatges adjuntes (fes clic per mostrar-les)",
  "office.tabs.scrollLeft": "Desplaça les sales a l'esquerra",
  "office.tabs.scrollRight": "Desplaça les sales a la dreta",
  "office.tabs.roomSettings": "Fes doble clic per a la configuració de la sala",
  "office.tabs.closeEmptyRoom": "Tanca la sala buida",
  "office.tabs.newRoom": "Crea una sala nova",
  "office.tabs.onlineUsers.one": "{count} usuari en línia",
  "office.tabs.onlineUsers.other": "{count} usuaris en línia",
  "office.zoom.in": "Apropa",
  "office.zoom.out": "Allunya",
  "office.zoom.reset": "Restableix la vista (0)",
  "office.zoom.resetAria": "Restableix la vista",
  "office.pet.label": "Mascota de la sala",
  "office.pet.species.cat": "Gat",
  "office.pet.species.dog": "Gos",
  "office.pet.species.rabbit": "Conill",
  "office.pet.species.tortoise": "Tortuga",
  "office.pet.coat": "{species} {number}",
  "office.pet.coatAria": "{species}, pelatge {number}",
  "office.desk.swapBadge": "INTERCANVIA",
  "office.status.working": "treballant",
  "office.status.waiting": "esperant",
  "office.status.error": "amb error",
  "office.status.idle": "inactius",
  "office.status.errShort": "error",
  "office.hints.tap": "TOCA → obre",
  "office.hints.longPress": "MANTÉN PREMUT → accions",
  "office.hints.pinch": "PESSIGA → zoom",
  "office.hints.dragZoomed": "ARROSSEGA (amb zoom) → desplaça",
  "office.hints.click": "CLIC → obre l'agent",
  "office.hints.dragSwap":
    "ARROSSEGA → intercanvia escriptoris o mou a la porta",
  "office.hints.wheel": "RODA / +- → zoom",
  "office.hints.drag": "ARROSSEGA → desplaça",
  "office.hints.rightClick": "CLIC DRET → accions",
  "office.hints.resetView": "0 → restableix la vista",
  "office.pendingPrompt.permission": "permís",
  "office.pendingPrompt.resume": "sessió",
  "office.pendingPrompt.model": "model",
  "office.pendingPrompt.effort": "esforç",
  "office.pet.default": "Predeterminada",
  "contextMenu.editAgent": "Edita l'agent...",
  "contextMenu.newConversation": "Conversa nova",
  "contextMenu.newEngineConversation": "Conversa nova de {engine}",
  "contextMenu.resume": "Reprèn",
  "common.current": "(actual)",
  "contextMenu.branched": "(ramificada)",
  "contextMenu.killAgent": "Elimina l'agent",
  "agentList.roomEmpty": "{room} és buida",
  "agentList.thisRoom": "Aquesta sala",
  "agentList.noAgents": "Encara no hi ha agents",
  "agentList.spawnHint": "Toca + per crear-ne un",
  "app.reconnecting": "S'està reconnectant…",
  "themes.dark": "Fosc",
  "themes.light": "Clar",
  "themes.nord": "Nord",
  "themes.dracula": "Dracula",
  "themes.solarizedDark": "Solarized Dark",
  "themes.solarizedLight": "Solarized Light",
  "common.unknownSize": "mida desconeguda",
  "common.edit": "Edita",
  "schedules.tab.runs": "execucions",
  "schedules.tab.cronjobs": "programacions",
  "schedules.anyMoment": "en qualsevol moment",
  "schedules.createdByFor": "{creator} · per a {user}",
  "schedules.running": "en curs…",
  "schedules.newButton": "+ Nova",
  "schedules.filterLabel": "Programació:",
  "schedules.empty":
    'Encara no hi ha programacions. Fes clic a "+ Nova" per crear-ne una.',
  "schedules.runsEmpty": "Encara no hi ha execucions.",
  "schedules.enabledToggle": "Activada (fes clic per posar-la en pausa)",
  "schedules.pausedToggle": "En pausa (fes clic per activar-la)",
  "schedules.inFlight": "en curs",
  "schedules.runNow": "Executa-la ara",
  "schedules.run": "Executa",
  "schedules.deleted": "(eliminada)",
  "schedules.col.name": "NOM",
  "schedules.col.schedule": "PROGRAMACIÓ",
  "schedules.col.lastRun": "DARRERA",
  "schedules.col.nextRun": "SEGÜENT",
  "schedules.col.runs": "EXECUCIONS",
  "schedules.col.by": "PER",
  "schedules.col.status": "E",
  "schedules.col.trigger": "D",
  "schedules.col.started": "INICI",
  "schedules.col.preview": "VISTA PRÈVIA",
  "schedules.col.duration": "DURADA",
  "schedules.prevPage": "← Anterior",
  "schedules.nextPage": "Següent →",
  "schedules.paused": "en pausa",
  "schedules.status.running": "En curs",
  "schedules.status.completed": "Completada",
  "schedules.status.failed": "Fallida",
  "schedules.status.timedOut": "Temps esgotat",
  "schedules.status.skipped": "Omesa",
  "schedules.trigger.manual": "manual",
  "schedules.trigger.manualBy": "manual · {who}",
  "schedules.trigger.scheduled": "programada",
  "schedules.runNumber": "Execució núm. {id}",
  "schedules.promptLabel": "PROMPT",
  "schedules.snapshot":
    "cwd: {cwd} · model: {model} · esforç: {effort} · permís: {permission}",
  "schedules.errorLine": "Error: {reason}",
  "schedules.runSkipped": "Aquesta execució es va ometre.",
  "schedules.noEntries": "No hi ha entrades de registre.",
  "schedules.runningDots": "En curs...",
  "schedules.editingAbove": "S'està editant el missatge de dalt...",
  "schedules.followUp": "Envia un seguiment",
  "schedules.waitToFollowUp":
    "Execució en curs: espera que acabi abans d'enviar un seguiment.",
  "schedules.skippedNoSession":
    "Les execucions omeses no tenen cap sessió per reprendre.",
  "schedules.noSession":
    "Aquesta execució no es pot reprendre (no es va establir cap sessió).",
  "common.back": "Enrere",
  "apps.openApp": "Obre l'app",
  "apps.openOnNetwork": "Obre en aquesta xarxa",
  "apps.preview.notRunning":
    "Vista prèvia no disponible: l'app no està en marxa.",
  "apps.preview.noBrowser":
    "Vista prèvia no disponible: el Chrome no està instal·lat.",
  "apps.preview.unreachable": "Vista prèvia no disponible: l'app no respon.",
  "apps.preview.busy": "La vista prèvia està ocupada. Torna-ho a provar.",
  "apps.preview.failed": "No s'ha pogut capturar la vista prèvia.",
  "apps.preview.queued": "Vista prèvia en cua…",
  "apps.preview.capturing": "S'està capturant la vista prèvia…",
  "apps.preview.retrying": "La vista prèvia està ocupada. S'està reintentant…",
  "apps.preview.tryAgain": "Torna-ho a provar",
  "apps.preview.label": "Vista prèvia de la pantalla",
  "apps.hidePreviews": "Amaga les vistes prèvies de les apps",
  "apps.showPreviews": "Mostra les vistes prèvies de les apps",
  "apps.previewsOn": "vistes prèvies activades",
  "apps.previewsOff": "vistes prèvies desactivades",
  "apps.empty": "Encara no hi ha apps.",
  "apps.loadFailed": "No s'han pogut carregar les apps.",
  "apps.deleteFailed": "No s'ha pogut eliminar.",
  "apps.logReadFailed": "No s'ha pogut llegir el registre.",
  "apps.state.running": "en marxa",
  "apps.state.starting": "s'està engegant",
  "apps.state.stopped": "aturada",
  "apps.state.failed": "fallida",
  "apps.state.unknown": "desconegut",
  "apps.meta.port": "port",
  "apps.meta.createdBy": "creada per",
  "apps.meta.owner": "propietari",
  "apps.openAgent": "Obre l'agent",
  "apps.commandIn": "a {cwd}",
  "apps.verb.start": "engega",
  "apps.verb.stop": "atura",
  "apps.verb.restart": "reinicia",
  "apps.verbTitle.start": "Posa l'app en marxa",
  "apps.verbTitle.stop": "Atura l'app (les seves dades es conserven)",
  "apps.verbTitle.restart": "Atura l'app i torna-la a engegar",
  "apps.showLog": "Mostra la sortida recent de l'app",
  "apps.hideLog": "amaga el registre",
  "apps.log": "registre",
  "apps.removeTitle": "Treu l'app",
  "apps.delete": "elimina",
  "apps.cancel": "cancel·la",
  "apps.logEmpty": "Encara no hi ha res al registre.",
  "apps.confirmDelete":
    "Vols eliminar {name}? El seu directori de dades es conservarà.",
  "tasks.status.open": "Oberta",
  "tasks.status.inProgress": "En curs",
  "tasks.status.backlog": "Pendent",
  "tasks.status.done": "Feta",
  "tasks.unknownRoom": "Sala desconeguda",
  "tasks.newTask": "Tasca nova",
  "tasks.idCopied": "Copiat!",
  "tasks.copyId": "Copia l'ID de la tasca",
  "tasks.field.title": "Títol",
  "tasks.field.createIn": "Crea a",
  "tasks.field.room": "Sala",
  "tasks.field.description": "Descripció",
  "tasks.field.priority": "Prioritat",
  "tasks.field.status": "Estat",
  "tasks.field.assignee": "Responsable",
  "tasks.global": "Global (tota l'oficina)",
  "tasks.moveToRoom": "Mou aquesta tasca a una altra sala",
  "tasks.priorityNone": "Cap",
  "tasks.unassigned": "Sense responsable",
  "tasks.showRecentAgents": "Mostra només els agents recents",
  "tasks.showAllAgents": "Mostra tots els agents",
  "tasks.showLess": "mostra'n menys",
  "tasks.moreAgents": "+{count} més",
  "tasks.discardPrompt": "Vols descartar els canvis sense desar?",
  "tasks.discard": "Descarta",
  "tasks.create": "Crea",
  "tasks.confirmDelete": "Ho confirmes?",
  "tasks.globalShort": "Global",
  "tasks.heading": "Tasques",
  "tasks.shownCount": "{count} a la vista",
  "tasks.quickAdd": "Afegeix una tasca ràpida…",
  "tasks.fileIn": "arxiva a",
  "tasks.fileInTitle": "Les tasques noves s'arxiven en aquesta sala",
  "tasks.hintMobile": "Retorn per afegir detalls",
  "tasks.hintDesktop": "Retorn per afegir detalls · n per enfocar",
  "tasks.scopeTitle": "Filtra les tasques i tria on s'arxiven les noves",
  "tasks.allRooms": "Totes les sales",
  "tasks.filterActive": "Obertes + en curs",
  "tasks.filterAll": "Totes",
  "tasks.filterAssignee": "Filtra per responsable...",
  "tasks.searchPlaceholder": "Cerca tasques...",
  "tasks.col.status": "E",
  "tasks.col.priority": "P",
  "tasks.col.title": "TÍTOL",
  "tasks.col.assignee": "RESPONSABLE",
  "tasks.col.by": "PER",
  "tasks.col.age": "EDAT",
  "tasks.empty": "No hi ha tasques",
  "tasks.roomChipTitle": "Sala: {room}",
  "tasks.globalChipTitle": "Tasca global de l'oficina",
  "tasks.createdFor": "{who} · per a {target}",
  "office.noRooms.title": "No tens cap sala assignada",
  "office.noRooms.create":
    "Fes servir el <strong>+</strong> de la barra de pestanyes per crear la teva sala.",
  "office.noRooms.visibility":
    "Les sales que crees només les veieu, de manera predeterminada, tu i els propietaris de l'oficina (ells ho poden canviar).",
  "office.noRooms.askOwner":
    "També pots demanar a un propietari que t'afegeixi a sales ja existents.",
  "office.newAgent": "Agent nou",
  "apps.actionFailed.start": "No s'ha pogut engegar.",
  "apps.actionFailed.stop": "No s'ha pogut aturar.",
  "apps.actionFailed.restart": "No s'ha pogut reiniciar.",
  "common.untitledConversation": "Conversa sense títol",
  "schedules.human.daily": "Cada dia a les {time}",
  "schedules.human.weekly": "Cada setmana, {weekday} a les {time}",
  "schedules.human.everyMinutes": "Cada {minutes}m",
  "schedules.human.everyHours": "Cada {hours}h",
  "schedules.human.everyHoursMinutes": "Cada {hours}h{minutes}m",
  "schedules.nextRunIn": "d'aquí a {duration}",

  "commands.clear.description": "Esborrar l'historial de la conversa",
  "commands.context.description": "Veure l'ús de la finestra de context",
  "commands.help.description": "Llistar totes les ordres disponibles",
  "commands.resume.description": "Reprendre una sessió anterior",
  "commands.login.description": "Veure com autenticar (de nou) aquest agent",
  "commands.logout.description": "Gestionar l'inici de sessió o tancar-la",
  "commands.isomuxAllHands.description":
    "Resum de tots els agents i les seves converses",
  "commands.isomuxSystemPrompt.description":
    "Veure el prompt de sistema complet que rep aquest agent",
  "commands.isomuxCronjobSystemPrompt.description":
    "Veure el prompt de sistema que rep una programació (passa-hi el nom o l'id)",
  "commands.isomuxDiff.description":
    "Veure els canvis sense confirmar al cwd de l'agent (o passa-hi un directori)",
  "commands.isomuxEdit.description":
    "Obrir un fitxer al plafó lateral de l'editor (relatiu al cwd, absolut o ~/...)",
  "commands.isomuxUsage.description":
    "Despesa de tokens per agent, per sala i per programació",
  "commands.isomuxStorage.description":
    "Espai de disc que fa servir l'oficina, desglossat per categoria",
  "commands.compact.description": "Comprimir el context",
  "commands.compact.message":
    "`/compact` encara no està disponible a Isomux. L'SDK compacta el context automàticament.",
  "commands.branch.description": "Ramificar la conversa en una sessió nova",
  "commands.fork.description": "Ramificar la conversa en una sessió nova",
  "commands.export.description": "Exportar la conversa a un fitxer",
  "commands.plan.description": "Activar o desactivar el mode de planificació",
  "commands.rename.description": "Reanomenar la sessió actual",
  "commands.reset.description": "Reiniciar la conversa",
  "commands.new.description": "Començar una conversa nova",
  "commands.model.description": "Canviar de model",
  "commands.fast.description": "Activar o desactivar el mode ràpid",
  "commands.effort.description": "Fixar el nivell d'esforç de raonament",
  "commands.advisor.description": "Activar o desactivar el mode assessor",
  "commands.cost.description": "Ús de tokens i cost estimat",
  "commands.cost.message":
    "`/cost` és una ordre de Claude Code per a qui fa servir l'API. Isomux factura per subscripció.",
  "commands.usage.description":
    "On consultar l'ús de la subscripció i de l'oficina",
  "commands.stats.description": "Patrons d'ús al llarg del temps",
  "commands.extraUsage.description": "Opcions d'ús addicional",
  "commands.rateLimitOptions.description":
    "Configuració del límit de peticions",
  "commands.diff.description":
    "Veure els canvis sense confirmar al cwd de l'agent (o passa-hi un directori)",
  "commands.rewind.description": "Desfer els canvis i revertir la conversa",
  "commands.checkpoint.description": "Desfer els canvis i revertir la conversa",
  "commands.copy.description": "Copiar l'última resposta al porta-retalls",
  "commands.files.description": "Llistar els fitxers que hi ha al context",
  "commands.addDir.description": "Afegir més directoris de treball",
  "commands.btw.description": "Preguntar sense embrutar el context principal",
  "commands.config.description": "Obrir la interfície de configuració",
  "commands.settings.description": "Obrir la interfície de configuració",
  "commands.hooks.description": "Gestionar els hooks del cicle de vida",
  "commands.permissions.description": "Gestionar els permisos de les eines",
  "commands.keybindings.description": "Editar les dreceres de teclat",
  "commands.memory.description": "Veure o editar la memòria persistent",
  "commands.mcp.description": "Gestionar les connexions a servidors MCP",
  "commands.ide.description": "Gestionar les integracions amb l'IDE",
  "commands.agents.description": "Gestionar els subagents personalitzats",
  "commands.skills.description": "Llistar totes les habilitats disponibles",
  "commands.sandbox.description": "Gestionar la configuració del sandbox",
  "commands.privacySettings.description":
    "Gestionar la configuració de privadesa",
  "commands.theme.description": "Canviar el tema de color",
  "commands.color.description": "Canviar el tema de color",
  "commands.vim.description": "Activar o desactivar les dreceres de vim",
  "commands.terminalSetup.description":
    "Configurar la integració amb el terminal",
  "commands.reloadPlugins.description":
    "Tornar a carregar els plugins instal·lats",
  "commands.reloadPlugins.message":
    "Per tornar a carregar els plugins, obre el terminal integrat (fes clic a la icona de terminal de l'escriptori de l'agent), executa `claude` i escriu `/reload-plugins`.",
  "commands.tasks.description": "Llistar o gestionar les tasques en segon pla",
  "commands.bashes.description": "Llistar o gestionar les tasques en segon pla",
  "commands.doctor.description": "Comprovar l'estat de la instal·lació",
  "commands.feedback.description": "Informar d'errors a Anthropic",
  "commands.bug.description": "Informar d'errors a Anthropic",
  "commands.releaseNotes.description": "Veure les notes de la versió",
  "commands.heapdump.description": "Bolcar el heap per depurar",
  "commands.status.description": "Veure l'estat del sistema",
  "commands.tag.description": "Etiquetar la conversa actual",
  "commands.init.description": "Inicialitzar Claude Code en un projecte",
  "commands.installGithubApp.description":
    "Configurar l'app de revisió de PR de Claude a GitHub",
  "commands.prComments.description": "Veure els comentaris del PR",
  "commands.desktop.description": "Obrir l'app d'escriptori",
  "commands.mobile.description": "Obrir l'app mòbil",
  "commands.chrome.description": "Obrir l'extensió de Chrome",
  "commands.session.description": "Gestionar les sessions",
  "commands.teleport.description": "Transferir la sessió a un altre dispositiu",
  "commands.remoteEnv.description": "Configurar l'entorn remot",
  "commands.exit.description": "Sortir de Claude Code",
  "commands.exit.message":
    "Fes servir la interfície d'Isomux per gestionar els agents. `/exit` només funciona a la CLI de Claude Code.",
  "commands.stickers.description": "Adhesius divertits",
  "commands.upgrade.description": "Actualitzar Claude Code",
  "commands.plugin.description": "Gestionar els plugins",
  "commands.plugin.message":
    "Gestionar plugins requereix la CLI de Claude Code directament.\n\nPer gestionar els plugins:\n1. Obre el terminal integrat (fes clic a la icona de terminal de l'escriptori de l'agent)\n2. Executa `claude`\n3. Escriu `/plugin` per explorar, instal·lar, activar o desactivar plugins\n\nOrdres útils:\n- `/plugin` - gestor interactiu de plugins (explorar, instal·lar, activar/desactivar)\n- `{addCommand}` - instal·lar un plugin pel seu nom\n- `/plugin marketplace add owner/repo` - afegir un marketplace de la comunitat\n\nDesprés d'instal·lar un plugin, executa `/reload-plugins` dins de la sessió de Claude per activar-lo.",
  "commands.batch.description":
    "Descompondre en agents paral·lels amb worktree",
  "commands.claudeApi.description":
    "Carregar la referència de l'API o l'SDK del llenguatge detectat",
  "commands.claudeInChrome.description":
    "Automatitzar interaccions amb el navegador Chrome",
  "commands.debug.description":
    "Diagnosticar problemes de sessió o d'eines des del log de depuració",
  "commands.keybindingsHelp.description":
    "Personalitzar les dreceres de teclat",
  "commands.loop.description": "Executar un prompt de manera periòdica",
  "commands.loop.message":
    "no està disponible de manera nativa; mira si la pàgina de Programacions o els missatges programats et serveixen",
  "commands.loremIpsum.description": "Generar text de farciment",
  "commands.review.description":
    "Revisió de codi a la cerca d'errors, lògica i casos límit",
  "commands.schedule.description": "Crear agents remots programats amb cron",
  "commands.securityReview.description":
    "Revisió de codi centrada en la seguretat",
  "commands.simplify.description": "Neteja de codi i anàlisi de reutilització",
  "commands.skillify.description":
    "Capturar processos com a habilitats reutilitzables",
  "commands.stuck.description": "Diagnosticar sessions blocades o lentes",
  "commands.ultrareview.description": "Revisió de PR ultraexhaustiva",
  "commands.updateConfig.description": "Configurar settings.json",
  "commands.unsupported.hardcoded":
    "`/{name}` ({description}) és una ordre de Claude Code, però no està disponible a Isomux.",
  "commands.unsupported.bundledSkill":
    "`/{name}` ({description}) és una habilitat inclosa a Claude Code, però no està disponible a Isomux. Pots substituir-la creant el teu propi fitxer d'habilitat.",
  "commands.unsupported.notAvailable": "`/{name}` no està disponible a Isomux.",
  "commands.unsupported.unknownCommand":
    "Ordre desconeguda `/{name}`. Escriu `/help` per veure les ordres disponibles.",
  "commands.clear.failed": "No s'ha pogut esborrar la conversa: {error}",
  "commands.clear.done": "Conversa esborrada.",
  "commands.context.header": "**{model}** - {used} / {max} tokens ({percent}%)",
  "commands.context.noSession": "No hi ha cap sessió activa.",
  "commands.context.unavailable":
    "L'ús de context no està disponible en aquesta sessió.",
  "commands.context.staleUnavailable":
    "No hi ha mesura en directe. Es mostra l'última lectura registrada, presa {age}.",
  "commands.context.staleFailed":
    "La mesura en directe ha fallat. Es mostra l'última lectura registrada, presa {age}.",
  "commands.context.ageUnderMinute": "fa menys d'un minut",
  "commands.context.ageMinutes": "fa {minutes}m",
  "commands.context.ageHoursMinutes": "fa {hours}h {minutes}m",
  "commands.context.category": "{name}: {tokens} tokens ({percent}%)",
  "commands.context.memoryFiles": "**Fitxers de memòria:**",
  "commands.context.memoryFile": "{path} ({tokens} tokens)",
  "commands.context.systemPrompt": "**Prompt de sistema:**",
  "commands.context.systemPromptSection": "{name}: {tokens} tokens",
  "commands.context.autoCompact":
    "Compactació automàtica al {percent}% ({tokens} tokens)",
  "commands.context.failed": "No s'ha pogut obtenir l'ús de context: {error}",
  "commands.help.docs": "**Documentació:** {url}",
  "commands.help.tips": "**Consells:**",
  "commands.help.tipAgents":
    "Els agents poden consultar-se i enviar-se missatges entre ells. Demana-ho amb naturalitat o fes servir habilitats com ara `/second-opinion`, `/pair-programming`, etc.",
  "commands.help.tipQueue":
    'Pots escriure mentre un agent està ocupat: els missatges es posen a la cua i surten quan queda lliure. Prem "Envia ara" o envia amb Ctrl/Cmd+Enter per interrompre i buidar la cua a l\'instant.',
  "commands.help.tipVoice":
    'Fes servir el dictat per veu per escriure més ràpid. La drecera és ctrl+space. La puntuació dictada s\'escriu com a puntuació: digues "question mark", "comma", "period", "new line", i així.',
  "commands.help.tipPhoneVpn":
    "Isomux funciona al mòbil. El més fàcil és connectar-lo a la mateixa VPN (per exemple Tailscale, que és gratuïta) que la màquina on s'executa.",
  "commands.help.tipInviteFunnel":
    "Quan l'oficina sigui accessible des de fora de la teva VPN (per exemple amb Tailscale Funnel; mira {url}), el propietari pot obrir Configuració d'usuari → Accés i generar URL d'invitació d'un sol ús. Qui les rep hi fa clic i entra: sense comptes ni contrasenyes.",
  "commands.help.tipPhoneOrigin": "Isomux funciona al mòbil: obre {origin}.",
  "commands.help.tipInvite":
    "El propietari pot obrir Configuració d'usuari → Accés i generar URL d'invitació d'un sol ús. Qui les rep hi fa clic i entra: sense comptes ni contrasenyes.",
  "commands.help.tipTerminal":
    "El terminal del plafó lateral va bé per a casos puntuals en què has d'executar alguna cosa a mà, com ara un inici de sessió.",
  "commands.help.tipHooks":
    "Isomux inclou hooks de seguretat previs a cada eina per als agents de Claude, que eviten ordres destructives. Els agents de Codex no tenen hooks equivalents.",
  "commands.help.commands": "**Ordres:**",
  "commands.help.aliasGroup": "{primary} (o {others})",
  "commands.help.skillsUser": "Habilitats d'usuari",
  "commands.help.skillsProject": "Habilitats del projecte",
  "commands.help.skillsPlugin": "Habilitats de plugins",
  "commands.help.skillsIsomux": "Habilitats d'Isomux",
  "commands.help.skillsClaude": "Habilitats de Claude",
  "commands.resume.none": "No hi ha sessions anteriors.",
  "commands.resume.header": "Reprèn una conversa anterior:",
  "commands.resume.noOthers": "No hi ha altres sessions per reprendre.",
  "commands.resume.branched": "(ramificada)",
  "commands.model.openCodeUnsupported":
    "Obre la configuració de l'agent per triar un model d'OpenCode connectat.",
  "commands.model.header": "Canviar de model (actual: **{current}**):",
  "commands.effort.openCodeUnsupported":
    "OpenCode no exposa controls d'esforç de raonament.",
  "commands.effort.header":
    "Canviar l'esforç de raonament (actual: **{current}**):",
  "commands.isomuxAllHands.room": "**=== Sala {number} ===**",
  "commands.isomuxAllHands.me": "**(jo)**",
  "commands.isomuxAllHands.desk": "escriptori {number}",
  "commands.isomuxAllHands.topic": "Tema: {topic}",
  "commands.isomuxAllHands.footer":
    "Pregunta-ho al teu agent si vols saber més sobre qualsevol agent o conversa.",
  "commands.isomuxSystemPrompt.header":
    "**Prompt de sistema complet** *(reflecteix la configuració actual; s'aplica a la propera conversa)*",
  "commands.isomuxCronjobSystemPrompt.usage": "Ús: {usage}",
  "commands.isomuxCronjobSystemPrompt.noSchedules":
    "No hi ha cap programació configurada.",
  "commands.isomuxCronjobSystemPrompt.known": "Programacions conegudes:",
  "commands.isomuxCronjobSystemPrompt.ambiguous":
    'Hi ha diverses programacions que es diuen "{query}". Torna-ho a executar amb l\'id:',
  "commands.isomuxCronjobSystemPrompt.noMatch":
    "Cap programació coincideix amb `{query}`. Prova `/isomux-cronjob-system-prompt` sense arguments per llistar-les.",
  "commands.isomuxCronjobSystemPrompt.header":
    "**Prompt de sistema i primer missatge d'usuari de la programació \"{name}\"** *(reflecteix la configuració actual; s'aplica a la propera execució)*",
  "commands.isomuxCronjobSystemPrompt.firstUserMessage":
    "Primer missatge d'usuari:",
  "commands.isomuxEdit.usage":
    "Ús: {usage}. El camí pot ser relatiu (es resol des de {cwd}), absolut o `~/...`.",
  "commands.isomuxEdit.emptyPath": "Camí buit.",
  "commands.isomuxEdit.notFound": "`{path}` no existeix.",
  "commands.isomuxEdit.notFile": "`{path}` no és un fitxer.",
  "commands.isomuxEdit.binary":
    "`{path}` és un fitxer binari: el plafó de l'editor només admet text.",
  "commands.isomuxEdit.tooLarge":
    "`{path}` ocupa {size}, massa per al plafó de l'editor (el límit és 1 MB).",
  "commands.isomuxEdit.ioError": "No s'ha pogut obrir `{path}`: {message}",
  "commands.isomuxDiff.notDirectory": "`{path}` no és un directori.",
  "commands.isomuxDiff.notRepo": "`{path}` no és un repositori de git.",
  "commands.isomuxDiff.gitError": "No s'ha pogut executar git diff a `{path}`:",
  "commands.isomuxDiff.clean":
    "L'arbre de treball de `{path}` està net: no hi ha canvis sense confirmar.",
  "commands.usage.heading":
    "**Aquí no es mostren els límits del pla de subscripció.**",
  "commands.usage.intro":
    "Per consultar la teva quota de subscripció de Claude o de ChatGPT, obre el terminal integrat i:",
  "commands.usage.claude": "executa `claude` i escriu `/usage`",
  "commands.usage.codex": "executa `~/.isomux/bin/codex` i escriu `/status`",
  "commands.usage.office":
    "Per a la despesa de tokens de l'oficina (per agent, per sala i per programació), mira `/isomux-usage`.",
  "commands.usage.codexCardOmitted":
    "S'omet la targeta de `/status` de Codex: {error}",
  "commands.isomuxStorage.forbidden":
    "L'ús de disc només està disponible per als membres de l'oficina que hagin iniciat sessió.",
  "commands.skill.queueFailed":
    "No s'ha pogut posar {command} a la cua: {error}",
  "commands.skill.error": "Error de l'habilitat: {error}",
  "choices.resume.title": "Reprendre una conversa",
  "choices.resume.instruction":
    "Respon amb un número per reprendre-la, o qualsevol altra cosa per cancel·lar.",
  "choices.resume.branched": "Ramificada",
  "choices.model.title": "Canviar de model",
  "choices.model.instruction":
    "Respon amb un número per canviar, o qualsevol altra cosa per cancel·lar.",
  "choices.effort.title": "Canviar l'esforç de raonament",
  "choices.permission.title": "Vol fer servir {tool}",
  "choices.permission.instruction":
    "Tria una opció, o escriu qualsevol altre missatge per denegar-ho amb aquest motiu.",
  "choices.permission.reply": "Respon:",
  "choices.permission.allowOnce": "Permet només aquesta vegada",
  "choices.permission.deny": "Denega",
  "choices.permission.allowPrefix":
    "Permet i no ho tornis a preguntar en aquesta sessió per cap ordre que comenci per `{prefix}`",
  "choices.permission.prefixHint":
    "Respon `{replySpec}` per triar fins on ho permets, per exemple `{index} {example}`.",
  "choices.permission.denyByMessage":
    "O escriu qualsevol altre missatge per denegar-ho amb aquest motiu.",
  "systemEntries.conversationCleared": "Conversa esborrada.",
  "systemEntries.newConversation": "Conversa nova iniciada.",
  "systemEntries.agentStopped": "L'agent s'ha aturat: {status}.",
  "systemEntries.backendFailure.stoppedDuringTurn":
    "El backend de l'agent s'ha aturat durant el torn. La conversa està desada i es pot reprendre.",
  "systemEntries.backendFailure.sigterm":
    "El backend de l'agent s'ha terminat amb SIGTERM (codi de sortida {code}). La causa més probable és la protecció contra manca de memòria d'aquesta màquina. La conversa està desada i es pot reprendre.",
  "systemEntries.backendFailure.sigkill":
    "El backend de l'agent s'ha matat amb SIGKILL (codi de sortida {code}). La causa més probable és la protecció contra manca de memòria d'aquesta màquina. La conversa està desada i es pot reprendre.",
  "systemEntries.backendFailure.signal":
    "El backend de l'agent s'ha aturat amb el senyal {signal} (codi de sortida {code}). La conversa està desada i es pot reprendre.",
  "systemEntries.agentReady":
    'L\'agent "{name}" està a punt. Treballa a {cwd}. Mode de permisos: {mode}.',
  "systemEntries.streamError": "Error de flux: {error}",
  "systemEntries.startFailed": "No s'ha pogut iniciar: {error}",
  "systemEntries.interrupted": "Agent interromput.",
  "systemEntries.wake.idle":
    "S'ha reprès la teva sessió (s'havia alliberat per inactivitat per estalviar memòria).",
  "systemEntries.wake.afterRestart":
    "S'ha reprès la teva sessió després de reiniciar el servidor.",
  "systemEntries.wake.afterBackendEnded":
    "S'ha reprès la teva sessió després que el backend acabés de manera inesperada.",
  "systemEntries.wake.inFlightWarning":
    "Pot ser que alguna ordre en curs s'executés a mitges; comprova'n els efectes abans de tornar-ho a provar.",
  "systemEntries.wake.shutdownRejection":
    "El resultat \"user rejected\" d'aquí sobre ve de l'aturada, no d'una persona.",
  "systemEntries.wake.resumedBeforeFlush":
    "S'ha reprès la sessió anterior abans de buidar la cua de missatges.",
  "systemEntries.wake.resumedAfterUnexpectedEnd":
    "S'ha reprès la sessió anterior després que l'última acabés de manera inesperada.",
  "systemEntries.codexInterruptExited":
    "Codex s'ha tancat durant la interrupció; s'instal·la una sessió nova.",
  "systemEntries.codexInterruptExitedWithError":
    "Codex s'ha tancat durant la interrupció: {error}",
  "systemEntries.previousInterrupted":
    "La resposta anterior es va interrompre.",
  "systemEntries.interruptedPermissionDenied":
    "Agent interromput; la petició de permís pendent es va denegar.",
  "systemEntries.interruptedPermissionRestarted":
    "Agent interromput; la petició de permís pendent no es va poder denegar, així que es va reiniciar el backend de l'agent; la conversa es conserva.",
  "systemEntries.interruptHandlerFailed":
    "El gestor d'interrupcions ha fallat: {error}",
  "systemEntries.codexInterruptFallback":
    "Codex no va atendre la interrupció a temps; es passa a una sessió nova.",
  "systemEntries.deliveryStalled":
    "L'entrega del missatge s'ha encallat; s'està recuperant.",
  "systemEntries.freshSessionAfterRestoreFailure":
    "S'ha iniciat una sessió nova (l'anterior no s'ha pogut restaurar).",
  "systemEntries.freshSessionBeforeFlush":
    "S'ha iniciat una sessió nova abans de buidar la cua de missatges.",
  "systemEntries.flushStartFailed":
    "No s'ha pogut iniciar la sessió per buidar la cua: {error}",
  "systemEntries.restartingForSettings":
    "Es reinicia la sessió per aplicar la configuració; els missatges en cua sortiran després del reinici.",
  "systemEntries.flushError": "Error en buidar la cua: {error}",
  "systemEntries.genericError": "Error: {error}",
  "systemEntries.restoreOnStartupFailed":
    "No s'ha pogut restaurar en arrencar: {error}\nEscriu /clear per començar de zero, o /resume per triar una altra sessió.",
  "systemEntries.flushInterrupted":
    "El buidatge de la cua s'ha interromput per un canvi de sessió; es tornarà a provar.",
  "systemEntries.sessionStartFailed":
    "No s'ha pogut iniciar la sessió: {error}\nEscriu /clear per començar de zero, o /resume per triar una altra sessió.",
  "systemEntries.queueFailed":
    "No s'ha pogut posar el missatge a la cua: {error}",
  "systemEntries.queueCleared.notConfigured.one":
    "S'ha descartat {count} missatge en cua perquè el backend no està configurat.",
  "systemEntries.queueCleared.notConfigured.other":
    "S'han descartat {count} missatges en cua perquè el backend no està configurat.",
  "systemEntries.queueCleared.switching.one":
    "S'ha descartat {count} missatge en cua en canviar a una altra sessió.",
  "systemEntries.queueCleared.switching.other":
    "S'han descartat {count} missatges en cua en canviar a una altra sessió.",
  "systemEntries.contextCompacted": "Context compactat: {summary}",
  "systemEntries.contextCompactedNoSummary": "Context compactat.",
  "systemEntries.toolCallDenied": "Crida a l'eina denegada: {tool}",
  "systemEntries.toolCallDeniedWithReason":
    "Crida a l'eina denegada: {tool} ({reason})",
  "systemEntries.inputRequest":
    "El backend ha demanat una entrada interactiva que Isomux no pot mostrar de manera segura.",
  "systemEntries.permissionRequested":
    "Permís sol·licitat per a {tool}. Entrada: {input}.",
  "systemEntries.diffEmptyCommit":
    "`{commit}` no va introduir canvis a cap fitxer (commit buit?).",
  "systemEntries.permissionOutcome.allowPersistent":
    "Permet crides semblants en aquesta sessió",
  "systemEntries.permissionOutcome.allowPrefix":
    "Permet un prefix d'ordre en aquesta sessió",
  "systemEntries.permissionOutcome.denyWithReason": "Denega amb un motiu",
  "systemEntries.permissionOutcome.denyWhenStopped": "Denega en aturar-se",
  "systemEntries.permissionOutcome.sessionChanged":
    "Cancel·lat en canviar de sessió",
  "systemEntries.permissionOutcome.priorSessionStopped":
    "Cancel·lat mentre s'aturava la sessió anterior",
  "systemEntries.permissionOutcome.sessionEnded":
    "Cancel·lat perquè la sessió va acabar",
  "systemEntries.permissionOutcome.turnStopped":
    "Cancel·lat en aturar-se el torn",
  "systemEntries.permissionOutcome.agentKilled":
    "Cancel·lat en eliminar l'agent",
  "systemEntries.permissionOutcome.failed": "No s'ha pogut resoldre",
  "systemEntries.permissionChoice": "Permís triat: {label}.",
  "systemEntries.permissionGrantedOnce":
    "Permís concedit (només aquesta vegada).",
  "systemEntries.permissionGrantedPersistent":
    "Permís concedit (regla afegida per a aquesta sessió).",
  "systemEntries.permissionDenied": "Permís denegat.",
  "systemEntries.permissionDeniedWithReason":
    "Permís denegat; el motiu s'ha enviat a l'agent.",
  "systemEntries.permissionSessionGone":
    "El permís no s'ha pogut resoldre: la sessió ja no hi és.",
  "systemEntries.permissionResolveFailed":
    "No s'ha pogut resoldre el permís: {error}",
  "systemEntries.resumedSession": "Sessió represa: {label}",
  "systemEntries.resumeFailed": "No s'ha pogut reprendre: {error}",
  "systemEntries.resumeCancelled": "Represa cancel·lada.",
  "systemEntries.resumeCwdUnavailable":
    "El directori desat de la sessió `{stored}` no està disponible ({error}); es reprèn a `{previous}`.",
  "systemEntries.alreadyUsing": "Ja fa servir {label}.",
  "systemEntries.modelSwitched":
    "Model canviat a {label}. El context de l'agent pot continuar dient que és un altre model; el correcte és el de la barra superior.",
  "systemEntries.modelCancelled": "Canvi de model cancel·lat.",
  "systemEntries.effortSwitched": "Esforç de raonament canviat a {label}.",
  "systemEntries.effortCancelled": "Canvi d'esforç cancel·lat.",
  "systemEntries.branchedFrom": "Ramificada a partir de: {label}",
  "systemEntries.branchFailed": "No s'ha pogut ramificar la conversa: {error}",
  "systemEntries.editBusy": "No es pot editar mentre l'agent treballa.",
  "systemEntries.editNotFound": "No es pot editar: no es troba el missatge.",
  "systemEntries.editNoSession":
    "No es pot editar: no hi ha cap sessió activa.",
  "systemEntries.editPendingInteraction":
    "No es pot editar aquest prompt mentre hi ha una ordre interactiva pendent. Respon-la o cancel·la-la primer.",
  "systemEntries.editNotSent":
    "No es pot editar: aquest missatge no va arribar a l'agent i després n'hi va haver de més nous. Envia'n un de nou.",
  "systemEntries.editNotLocated":
    "No es pot editar: no es troba el missatge a la sessió del backend.",
  "systemEntries.editOtherSession":
    'Aquest missatge és en una altra sessió ("{label}"). Fes servir /resume per canviar-hi i edita\'l després.',
  "systemEntries.cwdMoveBackFailed":
    "Avís: després que fallés el canvi de cwd, els fitxers de sessió no s'han pogut tornar a {previous} i ara són a {target}; reprendre-la pot fallar fins que es restaurin.",
  "systemEntries.fileOpenFailed": "No s'ha pogut obrir `{path}`: {message}",
  "systemEntries.fileReadFailed": "No s'ha pogut llegir `{path}`: {message}",
  "systemEntries.fileTooLargeToDisplay":
    "`{path}` ocupa {size}: massa gran per mostrar-lo (límit de {limit} MB).",
  "systemEntries.fileSaveFailed":
    "No s'ha pogut desar `{path}` per mostrar-lo.",
  "systemEntries.diffFailed": "No s'ha pogut executar git diff a `{path}`:",
  "systemEntries.diffBadDir": "No es pot fer diff de `{path}`: {message}.",
  "systemEntries.diffClean":
    "L'arbre de treball de `{path}` està net: no hi ha canvis sense confirmar.",
  "systemEntries.signInRequired":
    "{provider} no ha pogut executar aquest missatge perquè no ha iniciat sessió. Inicia sessió a sota per continuar.",
  "systemEntries.manageSignIn": "Gestiona la teva sessió de {provider} a sota.",
  "systemEntries.alreadySignedIn":
    "Ja has iniciat sessió. Gestiona la teva sessió de {provider} a sota.",
  "systemEntries.signOutOpenCode":
    "Tancar la sessió no està disponible als agents d'OpenCode.",
  "systemEntries.signOutNoScope":
    "Tancar la sessió no està disponible perquè no s'ha pogut resoldre l'àmbit d'aquest compte de {provider}.",
  "systemEntries.runInTerminal": "Executa `{command}` al terminal integrat.",
  "updateNotice.pill.updateAvailable": "hi ha una actualització",
  "updateNotice.pill.newRelease": "versió nova",
  "updateNotice.pill.mainAhead": "main +{count}",
  "updateNotice.title.newRelease": "Hi ha una versió nova",
  "updateNotice.title.mainAhead": "Hi ha commits més nous a main",
  "updateNotice.running": "el commit {sha}",
  "updateNotice.identity.noLatest": "Estàs a {running}.",
  "updateNotice.identity.current": "Estàs a {running} (l'última versió).",
  "updateNotice.identity.behind": "Estàs a {running}; ja hi ha {latest}.",
  "updateNotice.identity.aheadTagged":
    "Estàs a {running} (més nou que l'última versió, {latest}).",
  "updateNotice.identity.aheadUntagged":
    "Estàs a {running}, per davant de l'última versió ({latest}).",
  "updateNotice.identity.unknown":
    "Estàs a {running}. L'última versió és {latest};",
  "updateNotice.drift.beyond.one": "main té {count} commit més enllà d'això.",
  "updateNotice.drift.beyond.other":
    "main té {count} commits més enllà d'això.",
  "updateNotice.drift.newer.one": "main té {count} commit més nou.",
  "updateNotice.drift.newer.other": "main té {count} commits més nous.",
  "updateNotice.drift.bleedingEdge.one":
    "main té {count} commit més nou si vols l'últim de l'últim.",
  "updateNotice.drift.bleedingEdge.other":
    "main té {count} commits més nous si vols l'últim de l'últim.",
  "storageReport.heading": "Emmagatzematge d'Isomux",
  "storageReport.totalWithOutside":
    "**{total} en total:** {stateRoot} d'estat de l'oficina, més {outside} a {locations}.",
  "storageReport.totalOnly":
    "**{total} en total**, tot plegat estat de l'oficina.",
  "storageReport.locationsJoin": " i ",
  "storageReport.measured": "_Mesurat {age}._",
  "storageReport.columnCategory": "Categoria",
  "storageReport.columnSize": "Mida",
  "storageReport.columnFiles": "Fitxers",
  "storageReport.none": "cap",
  "storageReport.totalOfficeState": "Total de l'estat de l'oficina",
  "storageReport.total": "Total",
  "storageReport.outsideNote":
    "_Les còpies de seguretat i les instantànies d'actualització són fora del directori d'estat de l'oficina, així que es llisten després del seu subtotal. \"cap\" vol dir que aquesta ubicació no està configurada en aquesta màquina._",
  "storageReport.locations": "_Ubicacions: {paths}._",
  "storageReport.locationOfficeState": "estat de l'oficina",
  "storageReport.locationNotSetUp": "{label} (sense configurar)",
  "storageReport.ownerOnly":
    "_El desglossament per agent i els camins són només per al propietari._",
  "storageReport.biggestAgents": "Agents més grans",
  "storageReport.columnAgent": "Agent",
  "storageReport.columnTranscripts": "Transcripcions",
  "storageReport.columnAttachments": "Adjunts",
  "storageReport.columnSessions": "Sessions",
  "storageReport.columnLastActivity": "Última activitat",
  "storageReport.killed": "_(eliminat)_",
  "storageReport.showing":
    "_Es mostren els {shown} agents més grans de {total} amb dades desades._",
  "storageReport.nothingDeleted":
    "_Aquí no s'esborra res automàticament. Les transcripcions i els adjunts només s'eliminen quan el propietari ho demana._",
  "storageReport.unknownSize": "mida desconeguda",

  // --- S9: the pre-sign-in pages the server renders itself -----------------
  // The claim page, the invite-accept page, the login page and the three
  // error pages of the same flow. No picker (ruling 5): the language comes
  // from the visitor's Accept-Language header, or from their stored
  // preference on the pages that can know them. The common.* keys here are
  // common because two of those pages share the byte-identical string
  // (ruling 15), not because anything outside this flow uses them yet.
  "common.continue": "Continua",
  "common.displayName": "Nom per mostrar",
  "common.returnToOffice": "Torna a l'oficina",
  "common.welcomeNewOffice":
    "Et donem la benvinguda a la teva nova oficina Isomux",
  "common.titleFirstTimeSetup": "configuració inicial",
  "common.titleInvite": "invitació",
  "common.ogTitleFirstTimeSetup": "Isomux - configuració inicial",
  "preAuth.login.title": "iniciar la sessió",
  "preAuth.login.openInvite":
    "Obre un enllaç d'invitació per iniciar la sessió en aquest dispositiu.",
  "preAuth.login.alreadySignedIn":
    "Ja tens la sessió iniciada en un altre lloc? Crea'n un a Configuració d'usuari allà.",
  "preAuth.login.askOwner": "Si no, demana'n un al propietari de l'oficina.",
  "preAuth.login.noOwner": "Aquesta oficina encara no té propietari.",
  "preAuth.login.claimHere": "Obre {link} per reclamar-ne la propietat.",
  "preAuth.login.claimHereLink": "la pàgina d'inici d'aquesta oficina",
  "preAuth.login.sshHint":
    "Si vols arribar a aquesta oficina des d'una altra màquina, primer necessites un túnel SSH (el formulari de reclamació només és accessible des de loopback). El registre d'arrencada del servidor indica l'ordre {command} exacta.",
  "preAuth.claim.intro":
    "Ets la primera persona que reclama aquesta oficina. Tria un nom per mostrar; apareixerà al costat de tot el que diguis.",
  "preAuth.claim.ogDescription":
    "Reclama la propietat d'una oficina Isomux nova.",
  "preAuth.claim.errorOwnerExists":
    "Aquesta oficina ja té propietari. Actualitza la pàgina i inicia la sessió amb un enllaç d'invitació.",
  "preAuth.claim.errorName":
    "Tria un nom per mostrar (lletres, xifres, espais, punts, guions, apòstrofs o guions baixos).",
  "preAuth.invite.titleAccept": "acceptar la invitació",
  "preAuth.invite.bootstrapIntro":
    "Ets la primera persona que reclama aquesta oficina. Tria un nom per mostrar - apareixerà al costat de tot el que diguis.",
  "preAuth.invite.heading": "Obre la teva invitació d'Isomux",
  "preAuth.invite.headingNamed":
    "Obre la teva invitació a l'oficina Isomux: {office}",
  "preAuth.invite.clickHint":
    "En prémer el botó de sota iniciaràs la sessió en aquest dispositiu.",
  "preAuth.invite.accept": "Accepta i continua",
  "preAuth.invite.errorName": "Tria un nom per mostrar.",
  "preAuth.invite.ogTitleAccept": "Isomux - acceptar la invitació",
  "preAuth.invite.ogDescriptionSetup":
    "Obre aquest enllaç per reclamar la propietat d'una oficina Isomux.",
  "preAuth.invite.ogDescriptionAccept":
    "Obre aquest enllaç per iniciar la sessió en una oficina Isomux en aquest dispositiu.",
  "preAuth.inviteError.heading": "Invitació no disponible",
  "preAuth.inviteError.consumed": "Aquesta invitació ja s'ha fet servir.",
  "preAuth.inviteError.expired": "Aquesta invitació ha caducat.",
  "preAuth.inviteError.roleMismatch":
    "Aquesta invitació no es pot acceptar perquè l'usuari que ja existeix té un altre rol. Demana al propietari que creï una invitació nova.",
  "preAuth.inviteError.ownerExists":
    "Aquesta oficina ja té propietari. Les invitacions inicials deixen de funcionar quan l'oficina ja està reclamada.",
  "preAuth.inviteError.generic": "Aquesta invitació ja no és vàlida.",
  "preAuth.conflict.heading": "Aquesta invitació és per a un altre usuari",
  "preAuth.conflict.body":
    "Has iniciat la sessió com a {current}. Aquesta invitació és per a {invitee}: obre-la al seu dispositiu o en un altre perfil del navegador.",
  "preAuth.signOutBlocked.title": "tancament de sessió bloquejat",
  "preAuth.signOutBlocked.heading": "Tancament de sessió bloquejat",
  "preAuth.signOutBlocked.lastOwnerSession":
    "Tancament de sessió rebutjat: aquesta és l'última sessió activa de propietari a l'oficina. Crea una altra invitació per a tu i accepta-la en un altre dispositiu abans de tornar-ho a provar.",
};
