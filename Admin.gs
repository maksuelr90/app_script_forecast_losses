// ===================================================================
// ===== PAINEL ADMINISTRATIVO (engrenagem no cabeçalho) =====
// ===================================================================
// Permite rodar manualmente as funções de sincronização do DataBase.gs
// direto do dashboard, sem precisar abrir o editor do Apps Script.
//
// AVISO DE SEGURANÇA: essa senha é só uma barreira simples (evita clique
// acidental de quem não deveria estar ali), NÃO é segurança real - qualquer
// pessoa com acesso ao dashboard e um pouco de conhecimento técnico
// consegue chamar essas funções direto pelo console do navegador, com ou
// sem senha. Não use isso pra proteger nada sensível de verdade.
const SENHA_ADMIN_ = 'adm*123';

function verificarSenhaAdmin(senha) {
  return senha === SENHA_ADMIN_;
}

// ===== Wrappers que capturam o Logger.log() da execução e devolvem como
// texto, pra exibir no modal do dashboard. =====

function executarAdminStartSync() {
  Logger.clear();
  startSync(false);
  return Logger.getLog();
}

function executarAdminForcarSync() {
  Logger.clear();
  forcarSync();
  return Logger.getLog();
}

function executarAdminResetarSincronizacaoTravada() {
  Logger.clear();
  resetarSincronizacaoTravada();
  return Logger.getLog();
}

function executarAdminVerificarProgressoSync() {
  Logger.clear();
  verificarProgressoSync();
  return Logger.getLog();
}
