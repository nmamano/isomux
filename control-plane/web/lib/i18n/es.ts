// Spanish. Informal register throughout (tú, never usted), short sentences,
// no filler - Nil's copy rule holds in every language (ruling 1).
//
// Typed as a complete record over the English keys, so a missing entry is a
// compile error rather than a page that quietly reads English.
//
// Buttons take the infinitive, headings and inline links take the imperative,
// as the office's catalogs set in S1. Product names, plan names, hostnames, SSH
// commands and the names of the English legal documents stay as they are
// (ruling 11).

import type { Catalog } from "./en";

export const es: Catalog = {
  "common.signOut": "Cerrar sesión",
  "common.backToOffices": "Tus oficinas",
  "common.continueToPayment": "Continuar al pago",
  "common.openOfficeAndSignIn": "Abre tu oficina e inicia sesión",

  "language.label": "Idioma",

  "home.signedOutLead":
    "<signin>Inicia sesión</signin> para configurar una oficina.",
  "home.signedInAs": "Sesión iniciada como {email}",
  "home.officeHeading": "Tu oficina",
  "home.ready": "lista",
  "home.notReady": "aún no está lista",
  "home.viewOffice": "Ver oficina",
  "home.setUpAnother": "<link>Configurar otra oficina</link>.",
  "home.noOffice":
    "Todavía no tienes ninguna oficina. <link>Configura una</link>.",

  "signIn.heading": "Iniciar sesión",
  "signIn.google": "Continuar con Google",

  "signup.heading": "Configura tu oficina",
  "signup.continue": "Continuar el registro",
  "signup.officeName": "Nombre de la oficina",
  "signup.addressPreview":
    "Tu oficina será <name>{hostname}</name>. No se puede cambiar después de la configuración.",
  "signup.choosePlan": "Elige tu oficina",
  "signup.planChangeNote":
    "Cambiar de plan después del registro todavía no está disponible.",
  "signup.couponLabel": "Código promocional (opcional)",
  "signup.couponHint":
    "Si has recibido un código promocional, introdúcelo aquí.",
  "signup.keyLabel": "Guarda la clave de administrador de tu servidor",
  "signup.keyNote":
    "Esta clave da acceso a todo tu servidor, no solo a la oficina de Isomux. La necesitas para instalar software como administrador y para gestionar o reparar tu servidor. Se ha generado en tu navegador y solo se te muestra a ti. Guárdala en un sitio al que solo tú tengas acceso. No podemos crear otra más tarde porque nos bloqueamos el acceso a tu servidor después de la configuración.",
  "signup.keyHowTo":
    "<label>Cómo usarla:</label> Es una clave privada SSH. Un chatbot puede guiarte para usarla y acceder a tu servidor desde un terminal, o un agente que se ejecute en tu ordenador puede usarla para acceder al servidor por ti.",
  "signup.keyHidden": "Clave privada oculta",
  "signup.keyHide": "Ocultar la clave privada",
  "signup.keyReveal": "Mostrar la clave privada",
  "signup.keyCopy": "Copiar la clave privada",
  "signup.keyCopied": "Copiada",
  "signup.keyDownload": "Descargar la clave privada",
  "signup.keySaved": "La he guardado",
  "signup.saveKeyReason":
    "Guarda la clave de administrador de tu servidor antes de continuar.",
  "signup.cryptoError":
    "Tu navegador no puede crear ni copiar la clave de administrador del servidor en esta página. Abre la página de registro por HTTPS en un navegador actual y vuelve a intentarlo.",
  "signup.clipboardError":
    "Tu navegador no ha podido copiar la clave de administrador del servidor. Muestra la clave y selecciónala desde el campo.",
  "signup.checkoutError":
    "No hemos podido abrir una página de pago ahora mismo. Vuelve a intentarlo en un momento.",
  "signup.refusedError":
    "No hemos podido continuar el registro. Recarga la página y vuelve a intentarlo.",

  "policy.notice":
    "Antes de pagar, revisa <terms>Terms of Service</terms>, <privacy>Privacy Policy</privacy> y <refund>Refund Policy</refund>.",

  "plan.priceLine": "{amount} por {period}",
  "plan.period.month": "mes",

  "steps.labelWaitingForPayment": "Esperando el pago",
  "steps.labelCreateInstance": "Pidiendo tu servidor",
  "steps.labelWaitForAddress": "Esperando la dirección del servidor",
  "steps.labelWaitForSsh": "Esperando a que el servidor responda",
  "steps.labelFirstContact": "Asegurando nuestro acceso temporal",
  "steps.labelInstallCustomerKey": "Instalando tu clave SSH",
  "steps.labelArmRevocation": "Programando la caducidad de nuestro acceso",
  "steps.labelWaitForPackageManager":
    "Esperando al gestor de paquetes del servidor",
  "steps.labelSetDns": "Configurando la dirección de tu oficina",
  "steps.labelRunInstaller": "Instalando isomux",
  "steps.labelVerifyHttps": "Comprobando tu oficina por HTTPS",
  "steps.labelMintInvite": "Preparando tu invitación de propietario",
  "steps.labelRevokeAccess": "Retirando nuestro acceso",
  "steps.labelPowerOff": "Suspendiendo la oficina",
  "steps.labelReboot": "Reiniciando tu servidor",
  "steps.labelPowerOn": "Recuperando tu oficina",
  "steps.labelExpireCheckout": "Cerrando un pago de reactivación sin terminar",
  "steps.labelCancelAsset": "Cancelando tu servidor con el proveedor",
  "steps.labelRemoveDns": "Retirando la dirección de tu oficina",

  "stepState.waiting": "sin empezar",
  "stepState.active": "en curso",
  "stepState.checking": "comprobando",
  "stepState.done": "hecho",
  "stepState.failed": "fallido",

  "office.duration.hours.one": "{count} hora",
  "office.duration.hours.other": "{count} horas",
  "office.duration.minutes.one": "{count} minuto",
  "office.duration.minutes.other": "{count} minutos",
  "office.duration.seconds.one": "{count} segundo",
  "office.duration.seconds.other": "{count} segundos",
  "office.runningFor": "en marcha desde hace {spoken}",
  "office.took": ", ha tardado {spoken}",

  "office.navLabel": "Navegación de la oficina",
  "office.ready": "Tu oficina está lista.",
  "office.notReady": "Tu oficina aún no está lista.",
  "office.completePayment":
    "Completa el pago para empezar a pedir tu servidor.",
  "office.openOffice": "Abrir tu oficina",
  "office.progressHeading": "Progreso",
  "office.otherWorkHeading": "Otro trabajo en esta oficina",
  "office.gettingInHeading": "Cómo entrar",
  "office.sshAccess": "Tu acceso SSH: <cmd>{command}</cmd>",

  "office.attention.heading": "Tenemos que revisar tu configuración",
  "office.attention.seen": " (ya lo hemos visto)",
  "office.attention.note":
    "No tienes que hacer nada. Ya se nos ha avisado. Si este mensaje sigue aquí dentro de 12 horas, escribe a <mail>{address}</mail>.",
  "attention.labelInactivityDeadline":
    "Un paso está tardando más de lo esperado. Seguiremos configurando tu oficina.",
  "attention.labelAbsoluteDeadline":
    "Un paso ha superado su límite de tiempo. Revisaremos tu configuración.",
  "attention.labelOperationCondition":
    "Un paso necesita nuestra atención. Revisaremos tu configuración.",

  "office.access.notStarted":
    "Hosted Isomux Provisioning todavía no tiene una clave de tu servidor.",
  "office.access.gone":
    "Hosted Isomux Provisioning ya no tiene una clave de tu servidor.",
  "office.access.needsAttention":
    "Hosted Isomux Provisioning no puede confirmar si todavía tiene una clave de tu servidor.",
  "office.access.holdsUntil":
    "Hosted Isomux Provisioning tiene una clave temporal de tu servidor, hasta el {date} como máximo.",
  "office.access.holds":
    "Hosted Isomux Provisioning tiene una clave temporal de tu servidor.",

  "office.invite.heading": "Consigue tu invitación de propietario",
  "office.invite.notYet": "Espera a que la oficina esté sirviendo.",
  "office.invite.get": "Conseguir mi invitación de propietario",
  "office.invite.resend": "Enviarme una invitación nueva",
  "office.invite.resendCaveat":
    "Una invitación nueva sustituye a la anterior, que deja de funcionar.",
  "office.invite.closed":
    "Hosted Isomux Provisioning ya no puede crear invitaciones para esta oficina. Si no puedes entrar, contacta con soporte.",
  "office.invite.asking": "Pidiendo una invitación...",
  "office.invite.failed":
    "No hemos podido preparar una invitación. Vuelve a pedirla.",
  "office.invite.waiting": "Preparando tu invitación. Tarda unos segundos.",
  "office.invite.gone": "esa invitación ya no está disponible",
  "office.invite.slow":
    "preparar tu invitación está tardando más de lo esperado. Vuelve a pedirla.",
  "office.invite.askFailed":
    "no hemos podido pedir una invitación ahora mismo.",
  "office.invite.linkNote":
    "Ábrelo desde el perfil del navegador donde vayas a usar la oficina (no en incógnito). Funciona una vez y desaparece a los cinco minutos; si lo pierdes, pide otro. Puedes añadir tus otros dispositivos más tarde desde dentro de la oficina.",

  "office.signIn.shownOnce":
    "Tu enlace se mostró una vez y no se guarda. Pide otro arriba si todavía necesitas iniciar sesión.",
  "office.signIn.adopted":
    "Abre tu oficina arriba y comprueba que funciona en este navegador.",
  "office.signIn.pending":
    "Tu enlace de acceso aparecerá aquí cuando la invitación esté lista.",

  "office.handoff.heading":
    "Confirma el acceso a la oficina y retira nuestro acceso",
  "office.handoff.warning":
    "No continúes hasta que tu oficina esté abierta en este navegador. Después de retirarlo, Hosted Isomux Provisioning no puede crear otra invitación de propietario para ti.",
  "office.handoff.confirm":
    "Haz clic para confirmar que tu oficina está abierta en este navegador.",
  "office.handoff.inviteRequired":
    "Consigue tu invitación de propietario y abre tu oficina antes de confirmar.",
  "office.handoff.remove": "Retirar el acceso de Hosted Isomux Provisioning",
  "office.handoff.removing": "Retirando el acceso temporal...",
  "office.handoff.pending":
    "Hemos recibido tu solicitud. Estamos retirando nuestro acceso temporal.",
  "office.handoff.failedLower":
    "no hemos podido retirar nuestro acceso ahora mismo.",
  "office.handoff.failed":
    "No hemos podido retirar nuestro acceso ahora mismo.",

  "office.revocation.heading": "Retirada del acceso",
  "office.revocation.done":
    "Hosted Isomux Provisioning ya no tiene una clave de tu servidor. Lo hemos confirmado intentando reconectar con ella y siendo rechazados.",
  "office.revocation.failed":
    "No hemos podido retirar nuestra clave y hemos pedido a una persona que lo termine. La caducidad de tu propio servidor la retira igualmente en la fecha máxima que se muestra arriba.",
  "office.revocation.checking":
    "Estamos retirando nuestra clave y todavía no lo hemos podido confirmar. Hemos pedido a una persona que lo compruebe. La caducidad de tu propio servidor la retira igualmente en la fecha máxima que se muestra arriba.",
  "office.revocation.removing":
    "Estamos retirando nuestra clave de tu servidor.",

  "office.livenessHeading": "¿Responde?",
  "office.liveness.unreachable":
    "Tu oficina no ha respondido a sus últimas {strikes} comprobaciones: {words}. Ya se nos ha avisado.",
  "office.liveness.strike": "La última comprobación no llegó: {words}.",
  "office.liveness.ok": "Comprobado ahora mismo: {words}.",
  "liveness.labelDns": "esperando a que el nombre se resuelva",
  "liveness.labelWrongBox": "el nombre apunta a otro sitio",
  "liveness.labelTcp": "esperando a que la oficina acepte conexiones",
  "liveness.labelTls": "esperando el certificado",
  "liveness.labelReadyz": "esperando a que la oficina se declare lista",
  "liveness.labelOk": "la oficina está sirviendo",

  "office.restartHeading": "Reinicio",
  "office.restartCaveat":
    "Reiniciar apaga y enciende todo el servidor, no solo isomux. Interrumpe todos los agentes que estén en marcha y tarda un par de minutos.",
  "office.restart": "Reiniciar mi servidor",
  "office.restarting": "Reiniciando...",
  "office.action.restartServer": "reiniciar tu servidor",
  "office.action.failedLower": "no hemos podido {action} ahora mismo.",
  "office.action.failed": "No hemos podido {action} ahora mismo.",

  "office.planHeading": "Tu plan",
  "office.plan.waitingForPayment": "esperando la confirmación del pago",
  "office.plan.noCharge": ", sin cargo",
  "office.plan.periodEnds": "el periodo termina el {date}",
  "office.plan.nextInvoice": "próxima factura {date}",

  "office.cancel.pendingCancel":
    "Hemos pedido a Stripe que cancele tu suscripción. Esta página se actualiza cuando Stripe lo confirma.",
  "office.cancel.pendingUncancel":
    "Hemos pedido a Stripe que mantenga tu suscripción. Esta página se actualiza cuando Stripe lo confirma.",
  "office.cancel.ended": "Esta oficina se ha eliminado.",
  "office.cancel.reinstatePending":
    "Tu oficina sigue apagada mientras el pago está pendiente. Completa el pago antes del {deadline} para reactivar esta misma oficina.",
  "office.cancel.reinstateExpired":
    "Se ha alcanzado la fecha límite de reactivación. Este pago ya no puede reactivar la oficina.",
  "office.cancel.suspended":
    "Tu oficina está apagada. Reactiva tu suscripción antes del {date} para restaurarla, o contacta con soporte para tener acceso temporal gratuito a tu oficina y sacar tus datos. Después del {date}, tu oficina no se puede recuperar.",
  "office.cancel.retentionEnded":
    "El periodo de retención de esta oficina ha terminado. Ya no se puede recuperar.",
  "office.cancel.powerOffLaunch":
    "Tu suscripción terminó el {endedAt}. Tu oficina se está apagando. Reactiva tu suscripción antes del {date} para restaurarla, o contacta con soporte para tener acceso temporal gratuito a tu oficina y sacar tus datos. Después del {date}, tu oficina no se puede recuperar.",
  "office.cancel.restartRefusedLaunch":
    "Esta oficina no se puede reiniciar. El panel de tu oficina muestra las opciones disponibles ahora.",
  "office.cancel.grace":
    "Tu suscripción terminó el {endedAt}. Tu oficina sigue sirviendo hasta el {graceEnd} para que puedas sacar tu trabajo. Después de eso tu servidor se apaga.",
  "office.cancel.restartRefused":
    "Esta oficina no se puede reiniciar aquí después de la suspensión. Contacta con soporte si necesitas ayuda.",
  "office.cancel.scheduledLaunch":
    "Tu suscripción está programada para terminar el {date}. Tu oficina funciona durante el periodo que has pagado y se apaga cuando ese periodo termina.",
  "office.cancel.scheduledLaunchRetention":
    "Conservamos los datos del servidor durante 14 días. Durante ese tiempo, reactiva tu suscripción para restaurar la misma oficina, o contacta con soporte para tener acceso temporal gratuito a tu oficina y sacar tus datos. Después de eso, tu oficina no se puede recuperar.",
  "office.cancel.scheduled":
    "Tu suscripción está programada para terminar el {date}. Tu oficina sigue sirviendo hasta el {date}, y después 7 días más hasta el {graceEnd}.",
  "office.cancel.scheduledAfter":
    "Después del {graceEnd} tu servidor se apaga. Tus datos se quedan en él durante un mes natural, y después el servidor se elimina de forma permanente.",
  "office.cancel.keep": "Mantener mi oficina",
  "office.cancel.keepCaveat":
    " Mantener tu oficina significa que tu suscripción se renueva el {date} y la facturación normal continúa.",
  "office.cancel.caveat":
    "Cancelar mantiene tu oficina en marcha hasta el final del periodo que has pagado.",
  "office.cancel.cancel": "Cancelar mi oficina",
  "office.cancel.planFailedLower":
    "no hemos podido cambiar tu plan ahora mismo.",
  "office.cancel.planFailed": "No hemos podido cambiar tu plan ahora mismo.",
  "office.reinstate.failedLower":
    "no hemos podido abrir el pago de reactivación.",
  "office.reinstate.return": "Volver al pago",
  "office.reinstate.reinstate": "Reactivar esta oficina",
  "office.refundNotice":
    "Puedes pedir un reembolso completo escribiendo a {address} dentro de los 7 días siguientes a tu primer pago. Si te reembolsamos, no conservamos los datos del servidor durante 14 días por si quieres restaurarlo más tarde.",

  "errors.reference": "Referencia: {reference}.",
  "errors.checkoutReservedConfiguration":
    "No hemos podido abrir una página de pago. Tu nombre está reservado.",
  "errors.paymentsConfiguration":
    "Los pagos no están disponibles ahora mismo.",
  "errors.checkoutReservedTransient":
    "No hemos podido abrir una página de pago ahora mismo. Tu nombre está reservado, así que vuelve a intentarlo en un momento.",
  "errors.reinstatementTransient":
    "No hemos podido abrir el pago de reactivación ahora mismo. Vuelve a intentarlo en un momento.",
  "errors.billingChangeAmbiguous":
    "No hemos podido confirmar tu cambio con nuestro proveedor de pagos. Compruébalo dentro de un momento antes de volver a intentarlo.",
  "errors.providerTransient":
    "No hemos podido contactar con nuestro proveedor de pagos ahora mismo. Vuelve a intentarlo en un momento.",
  "errors.checkoutSessionUnavailable":
    "No hemos podido comprobar tu página de pago ahora mismo - vuelve a intentarlo en un momento.",
  "errors.checkoutSessionUnsaved":
    "No hemos podido guardar tu página de pago ahora mismo - vuelve a intentarlo en un momento.",
};
