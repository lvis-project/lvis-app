/**
 * Spanish message catalog. Mirrors every key in ./en.
 */
import type { SeedMessageKey } from "./en.js";

export const es: Record<SeedMessageKey, string> = {
  "common.cancel": "Cancelar",
  "common.allow": "Permitir",
  "common.confirm": "Confirmar",
  "common.ok": "Aceptar",
  "common.save": "Guardar",
  "common.close": "Cerrar",
  "common.delete": "Eliminar",
  "common.remove": "Quitar",
  "common.retry": "Reintentar",
  "common.loading": "Cargando…",
  "common.error": "Error",
  "common.thinking": "Pensando…",
  "settings.appearance.language.title": "Idioma",
  "settings.appearance.language.description": "Elige el idioma usado en toda la app. Los cambios se aplican de inmediato.",
  "settings.appearance.language.saved": "Idioma actualizado.",
  "mainDialog.restart": "Reiniciar",
  "mainDialog.updateApplyTitle": "Aplicar actualización",
  "mainDialog.updateRestartMessage": "LVIS se reiniciará en v{version}.",
  "mainDialog.updateRestartDetail": "El trabajo en curso finalizará. ¿Quieres continuar?",
  "mainDialog.attachTitle": "Seleccionar archivos adjuntos",
  "mainDialog.installLocalPluginTitle": "Instalar plugin local (desarrollador)",
  "mainDialog.installLocalPluginMessage": "Selecciona la carpeta de build que contiene plugin.json",
  "mainDialog.unauthorizedFrame": "Marco no autorizado.",
  "mainDialog.noPersonasAvailable": "No hay personas disponibles",
  "mainDialog.exportConversationTitle": "Exportar conversación",
  "mainDialog.importConversationTitle": "Importar conversación",
};
