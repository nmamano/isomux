// Catalan. Informal register throughout (tu, never vostè), short sentences,
// no filler - Nil's copy rule holds in every language (ruling 1).
//
// Typed as a complete record over the English keys, so a missing entry is a
// compile error rather than a page that quietly reads English.
//
// Buttons take the imperative, as the office's catalogs set in S1. Product
// names, plan names, hostnames, SSH commands and the names of the English legal
// documents stay as they are (ruling 11).

import type { Catalog } from "./en";

export const ca: Catalog = {
  "common.signOut": "Tanca la sessió",
  "common.backToOffices": "Les teves oficines",
  "common.continueToPayment": "Continua al pagament",
  "common.openOfficeAndSignIn": "Obre la teva oficina i inicia la sessió",

  "language.label": "Idioma",

  "home.signedOutLead":
    "<signin>Inicia la sessió</signin> per configurar una oficina.",
  "home.signedInAs": "Sessió iniciada com a {email}",
  "home.officeHeading": "La teva oficina",
  "home.ready": "a punt",
  "home.notReady": "encara no està a punt",
  "home.viewOffice": "Vés a l'oficina",
  "home.setUpAnother": "<link>Configura una altra oficina</link>.",
  "home.noOffice": "Encara no tens cap oficina. <link>Configura'n una</link>.",

  "signIn.heading": "Inicia la sessió",
  "signIn.google": "Continua amb Google",

  "signup.heading": "Configura la teva oficina",
  "signup.continue": "Continua el registre",
  "signup.officeName": "Nom de l'oficina",
  "signup.addressPreview":
    "La teva oficina serà <name>{hostname}</name>. No es pot canviar després de la configuració.",
  "signup.choosePlan": "Tria la teva oficina",
  "signup.planChangeNote":
    "Canviar de pla després del registre encara no està disponible.",
  "signup.couponLabel": "Codi promocional (opcional)",
  "signup.couponHint": "Si has rebut un codi promocional, introdueix-lo aquí.",
  "signup.keyLabel": "Desa la clau d'administrador del teu servidor",
  "signup.keyNote":
    "Aquesta clau dona accés a tot el teu servidor, no només a l'oficina d'Isomux. La necessites per instal·lar programari com a administrador i per gestionar o reparar el teu servidor. S'ha generat al teu navegador i només se't mostra a tu. Desa-la en un lloc on només tu hi tinguis accés. No en podem crear una altra més tard perquè ens bloquegem l'accés al teu servidor després de la configuració.",
  "signup.keyHowTo":
    "<label>Com fer-la servir:</label> És una clau privada SSH. Un chatbot et pot guiar per fer-la servir i accedir al teu servidor des d'un terminal, o un agent que s'executi al teu ordinador la pot fer servir per accedir al servidor per tu.",
  "signup.keyHidden": "Clau privada amagada",
  "signup.keyHide": "Amaga la clau privada",
  "signup.keyReveal": "Mostra la clau privada",
  "signup.keyCopy": "Copia la clau privada",
  "signup.keyCopied": "Copiada",
  "signup.keyDownload": "Descarrega la clau privada",
  "signup.keySaved": "L'he desada",
  "signup.saveKeyReason":
    "Desa la clau d'administrador del teu servidor abans de continuar.",
  "signup.cryptoError":
    "El teu navegador no pot crear ni copiar la clau d'administrador del servidor en aquesta pàgina. Obre la pàgina de registre per HTTPS en un navegador actual i torna-ho a provar.",
  "signup.clipboardError":
    "El teu navegador no ha pogut copiar la clau d'administrador del servidor. Mostra la clau i selecciona-la des del camp.",
  "signup.checkoutError":
    "No hem pogut obrir una pàgina de pagament ara mateix. Torna-ho a provar d'aquí a un moment.",
  "signup.refusedError":
    "No hem pogut continuar el registre. Recarrega la pàgina i torna-ho a provar.",

  "policy.notice":
    "Abans de pagar, revisa <terms>Terms of Service</terms>, <privacy>Privacy Policy</privacy> i <refund>Refund Policy</refund>.",

  "plan.priceLine": "{amount} per {period}",
  "plan.period.month": "mes",

  "steps.labelWaitingForPayment": "Esperant el pagament",
  "steps.labelCreateInstance": "Demanant el teu servidor",
  "steps.labelWaitForAddress": "Esperant l'adreça del servidor",
  "steps.labelWaitForSsh": "Esperant que el servidor respongui",
  "steps.labelFirstContact": "Assegurant el nostre accés temporal",
  "steps.labelInstallCustomerKey": "Instal·lant la teva clau SSH",
  "steps.labelArmRevocation": "Programant la caducitat del nostre accés",
  "steps.labelWaitForPackageManager":
    "Esperant el gestor de paquets del servidor",
  "steps.labelSetDns": "Configurant l'adreça de la teva oficina",
  "steps.labelRunInstaller": "Instal·lant isomux",
  "steps.labelVerifyHttps": "Comprovant la teva oficina per HTTPS",
  "steps.labelMintInvite": "Preparant la teva invitació de propietari",
  "steps.labelRevokeAccess": "Retirant el nostre accés",
  "steps.labelPowerOff": "Suspenent l'oficina",
  "steps.labelReboot": "Reiniciant el teu servidor",
  "steps.labelPowerOn": "Recuperant la teva oficina",
  "steps.labelExpireCheckout":
    "Tancant un pagament de reactivació sense acabar",
  "steps.labelCancelAsset": "Cancel·lant el teu servidor amb el proveïdor",
  "steps.labelRemoveDns": "Retirant l'adreça de la teva oficina",

  "stepState.waiting": "sense començar",
  "stepState.active": "en curs",
  "stepState.checking": "comprovant",
  "stepState.done": "fet",
  "stepState.failed": "fallit",

  "office.duration.hours.one": "{count} hora",
  "office.duration.hours.other": "{count} hores",
  "office.duration.minutes.one": "{count} minut",
  "office.duration.minutes.other": "{count} minuts",
  "office.duration.seconds.one": "{count} segon",
  "office.duration.seconds.other": "{count} segons",
  "office.runningFor": "en marxa des de fa {spoken}",
  "office.took": ", ha trigat {spoken}",

  "office.navLabel": "Navegació de l'oficina",
  "office.ready": "La teva oficina està a punt.",
  "office.notReady": "La teva oficina encara no està a punt.",
  "office.completePayment":
    "Completa el pagament per començar a demanar el teu servidor.",
  "office.openOffice": "Obre la teva oficina",
  "office.progressHeading": "Progrés",
  "office.otherWorkHeading": "Altres tasques en aquesta oficina",
  "office.gettingInHeading": "Com entrar-hi",
  "office.sshAccess": "El teu accés SSH: <cmd>{command}</cmd>",

  "office.attention.heading": "Hem de revisar la teva configuració",
  "office.attention.seen": " (ja ho hem vist)",
  "office.attention.note":
    "No has de fer res. Ja se'ns ha avisat. Si aquest missatge encara hi és d'aquí a 12 hores, escriu a <mail>{address}</mail>.",
  "attention.labelInactivityDeadline":
    "Un pas triga més del que esperàvem. Continuarem configurant la teva oficina.",
  "attention.labelAbsoluteDeadline":
    "Un pas ha superat el seu límit de temps. Revisarem la teva configuració.",
  "attention.labelOperationCondition":
    "Un pas necessita la nostra atenció. Revisarem la teva configuració.",

  "office.access.notStarted":
    "Hosted Isomux Provisioning encara no té una clau del teu servidor.",
  "office.access.gone":
    "Hosted Isomux Provisioning ja no té una clau del teu servidor.",
  "office.access.needsAttention":
    "Hosted Isomux Provisioning no pot confirmar si encara té una clau del teu servidor.",
  "office.access.holdsUntil":
    "Hosted Isomux Provisioning té una clau temporal del teu servidor, fins al {date} com a màxim.",
  "office.access.holds":
    "Hosted Isomux Provisioning té una clau temporal del teu servidor.",

  "office.invite.heading": "Aconsegueix la teva invitació de propietari",
  "office.invite.notYet": "Espera que l'oficina estigui servint.",
  "office.invite.get": "Aconsegueix la meva invitació de propietari",
  "office.invite.resend": "Envia'm una invitació nova",
  "office.invite.resendCaveat":
    "Una invitació nova substitueix l'anterior, que deixa de funcionar.",
  "office.invite.closed":
    "Hosted Isomux Provisioning ja no pot crear invitacions per a aquesta oficina. Si no hi pots entrar, contacta amb el suport.",
  "office.invite.asking": "Demanant una invitació...",
  "office.invite.failed":
    "No hem pogut preparar una invitació. Torna-la a demanar.",
  "office.invite.waiting": "Preparant la teva invitació. Triga uns segons.",
  "office.invite.gone": "aquesta invitació ja no està disponible",
  "office.invite.slow":
    "preparar la teva invitació triga més del que esperàvem. Torna-la a demanar.",
  "office.invite.askFailed": "no hem pogut demanar una invitació ara mateix.",
  "office.invite.linkNote":
    "Obre'l des del perfil del navegador on faràs servir l'oficina (no en incògnit). Funciona un cop i desapareix al cap de cinc minuts; si el perds, demana'n un altre. Pots afegir els teus altres dispositius més tard des de dins de l'oficina.",

  "office.signIn.shownOnce":
    "El teu enllaç s'ha mostrat un cop i no es desa. Demana'n un altre a dalt si encara has d'iniciar la sessió.",
  "office.signIn.adopted":
    "Obre la teva oficina a dalt i comprova que funciona en aquest navegador.",
  "office.signIn.pending":
    "El teu enllaç d'accés apareixerà aquí quan la invitació estigui a punt.",

  "office.handoff.heading":
    "Confirma l'accés a l'oficina i retira el nostre accés",
  "office.handoff.warning":
    "No continuïs fins que la teva oficina estigui oberta en aquest navegador. Després de retirar-lo, Hosted Isomux Provisioning no pot crear una altra invitació de propietari per a tu.",
  "office.handoff.confirm":
    "Fes clic per confirmar que la teva oficina està oberta en aquest navegador.",
  "office.handoff.inviteRequired":
    "Aconsegueix la teva invitació de propietari i obre la teva oficina abans de confirmar.",
  "office.handoff.remove": "Retira l'accés de Hosted Isomux Provisioning",
  "office.handoff.removing": "Retirant l'accés temporal...",
  "office.handoff.pending":
    "Hem rebut la teva sol·licitud. Estem retirant el nostre accés temporal.",
  "office.handoff.failedLower":
    "no hem pogut retirar el nostre accés ara mateix.",
  "office.handoff.failed": "No hem pogut retirar el nostre accés ara mateix.",

  "office.revocation.heading": "Retirada de l'accés",
  "office.revocation.done":
    "Hosted Isomux Provisioning ja no té una clau del teu servidor. Ho hem confirmat intentant reconnectar-hi i sent rebutjats.",
  "office.revocation.failed":
    "No hem pogut retirar la nostra clau i hem demanat a una persona que ho acabi. La caducitat del teu propi servidor la retira igualment en la data màxima que es mostra a dalt.",
  "office.revocation.checking":
    "Estem retirant la nostra clau i encara no ho hem pogut confirmar. Hem demanat a una persona que ho comprovi. La caducitat del teu propi servidor la retira igualment en la data màxima que es mostra a dalt.",
  "office.revocation.removing":
    "Estem retirant la nostra clau del teu servidor.",

  "office.livenessHeading": "Respon?",
  "office.liveness.unreachable":
    "La teva oficina no ha respost a les últimes {strikes} comprovacions: {words}. Ja se'ns ha avisat.",
  "office.liveness.strike": "L'última comprovació no ha arribat: {words}.",
  "office.liveness.ok": "Comprovat ara mateix: {words}.",
  "liveness.labelDns": "esperant que el nom es resolgui",
  "liveness.labelWrongBox": "el nom apunta a un altre lloc",
  "liveness.labelTcp": "esperant que l'oficina accepti connexions",
  "liveness.labelTls": "esperant el certificat",
  "liveness.labelReadyz": "esperant que l'oficina es declari a punt",
  "liveness.labelOk": "l'oficina està servint",

  "office.restartHeading": "Reinici",
  "office.restartCaveat":
    "Reiniciar apaga i encén tot el servidor, no només isomux. Interromp tots els agents que estiguin en marxa i triga un parell de minuts.",
  "office.restart": "Reinicia el meu servidor",
  "office.restarting": "Reiniciant...",
  "office.action.restartServer": "reiniciar el teu servidor",
  "office.action.failedLower": "no hem pogut {action} ara mateix.",
  "office.action.failed": "No hem pogut {action} ara mateix.",

  "office.planHeading": "El teu pla",
  "office.plan.waitingForPayment": "esperant la confirmació del pagament",
  "office.plan.noCharge": ", sense càrrec",
  "office.plan.periodEnds": "el període acaba el {date}",
  "office.plan.nextInvoice": "propera factura {date}",

  "office.cancel.pendingCancel":
    "Hem demanat a Stripe que cancel·li la teva subscripció. Aquesta pàgina s'actualitza quan Stripe ho confirma.",
  "office.cancel.pendingUncancel":
    "Hem demanat a Stripe que mantingui la teva subscripció. Aquesta pàgina s'actualitza quan Stripe ho confirma.",
  "office.cancel.ended": "Aquesta oficina s'ha eliminat.",
  "office.cancel.reinstatePending":
    "La teva oficina continua apagada mentre el pagament està pendent. Completa el pagament abans del {deadline} per reactivar aquesta mateixa oficina.",
  "office.cancel.reinstateExpired":
    "S'ha arribat a la data límit de reactivació. Aquest pagament ja no pot reactivar l'oficina.",
  "office.cancel.suspended":
    "La teva oficina està apagada. Reactiva la teva subscripció abans del {date} per restaurar-la, o contacta amb el suport per tenir accés temporal gratuït a la teva oficina i treure'n les dades. Després del {date}, la teva oficina no es pot recuperar.",
  "office.cancel.retentionEnded":
    "El període de retenció d'aquesta oficina s'ha acabat. Ja no es pot recuperar.",
  "office.cancel.powerOffLaunch":
    "La teva subscripció es va acabar el {endedAt}. La teva oficina s'està apagant. Reactiva la teva subscripció abans del {date} per restaurar-la, o contacta amb el suport per tenir accés temporal gratuït a la teva oficina i treure'n les dades. Després del {date}, la teva oficina no es pot recuperar.",
  "office.cancel.restartRefusedLaunch":
    "Aquesta oficina no es pot reiniciar. El tauler de la teva oficina mostra les opcions disponibles ara.",
  "office.cancel.grace":
    "La teva subscripció es va acabar el {endedAt}. La teva oficina continua servint fins al {graceEnd} perquè puguis treure la teva feina. Després d'això el teu servidor s'apaga.",
  "office.cancel.restartRefused":
    "Aquesta oficina no es pot reiniciar aquí després de la suspensió. Contacta amb el suport si necessites ajuda.",
  "office.cancel.scheduledLaunch":
    "La teva subscripció està programada per acabar el {date}. La teva oficina funciona durant el període que has pagat i s'apaga quan aquest període s'acaba.",
  "office.cancel.scheduledLaunchRetention":
    "Conservem les dades del servidor durant 14 dies. Durant aquest temps, reactiva la teva subscripció per restaurar la mateixa oficina, o contacta amb el suport per tenir accés temporal gratuït a la teva oficina i treure'n les dades. Després d'això, la teva oficina no es pot recuperar.",
  "office.cancel.scheduled":
    "La teva subscripció està programada per acabar el {date}. La teva oficina continua servint fins al {date}, i després 7 dies més fins al {graceEnd}.",
  "office.cancel.scheduledAfter":
    "Després del {graceEnd} el teu servidor s'apaga. Les teves dades s'hi queden durant un mes natural, i després el servidor s'elimina de manera permanent.",
  "office.cancel.keep": "Mantén la meva oficina",
  "office.cancel.keepCaveat":
    " Mantenir la teva oficina vol dir que la teva subscripció es renova el {date} i la facturació normal continua.",
  "office.cancel.caveat":
    "Cancel·lar manté la teva oficina en marxa fins al final del període que has pagat.",
  "office.cancel.cancel": "Cancel·la la meva oficina",
  "office.cancel.planFailedLower":
    "no hem pogut canviar el teu pla ara mateix.",
  "office.cancel.planFailed": "No hem pogut canviar el teu pla ara mateix.",
  "office.reinstate.failedLower":
    "no hem pogut obrir el pagament de reactivació.",
  "office.reinstate.return": "Torna al pagament",
  "office.reinstate.reinstate": "Reactiva aquesta oficina",
  "office.refundNotice":
    "Pots demanar un reemborsament complet escrivint a {address} dins dels 7 dies següents al teu primer pagament. Si et reemborsem, no conservem les dades del servidor durant 14 dies per si la vols restaurar més tard.",

  "errors.reference": "Referència: {reference}.",
  "errors.checkoutReservedConfiguration":
    "No hem pogut obrir una pàgina de pagament. El teu nom està reservat.",
  "errors.paymentsConfiguration":
    "Els pagaments no estan disponibles ara mateix.",
  "errors.checkoutReservedTransient":
    "No hem pogut obrir una pàgina de pagament ara mateix. El teu nom està reservat, així que torna-ho a provar d'aquí a un moment.",
  "errors.reinstatementTransient":
    "No hem pogut obrir el pagament de reactivació ara mateix. Torna-ho a provar d'aquí a un moment.",
  "errors.billingChangeAmbiguous":
    "No hem pogut confirmar el teu canvi amb el nostre proveïdor de pagaments. Comprova-ho d'aquí a un moment abans de tornar-ho a provar.",
  "errors.providerTransient":
    "No hem pogut contactar amb el nostre proveïdor de pagaments ara mateix. Torna-ho a provar d'aquí a un moment.",
  "errors.checkoutSessionUnavailable":
    "No hem pogut comprovar la teva pàgina de pagament ara mateix - torna-ho a provar d'aquí a un moment.",
  "errors.checkoutSessionUnsaved":
    "No hem pogut desar la teva pàgina de pagament ara mateix - torna-ho a provar d'aquí a un moment.",
};
