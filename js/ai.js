/*
 * 사진 판정 「AI 도우미」 자동 모드 — 이 도구에서 밖으로 요청을 보내는 유일한 곳입니다.
 *
 * - 폐쇄망 모드(설정 기본값 켬)에서는 부르지 않고, 불러도 여기서 막습니다.
 * - 사용자가 자기 OpenAI API 키를 넣었을 때만 브라우저에서 api.openai.com 으로 요청문과 사진(가이드 + 실제 사진)을 보냅니다.
 *   키는 이 브라우저 저장소에만 두고 코드·리포·백업 파일에는 넣지 않습니다(공개 리포).
 * - AI 답은 「제안」으로만 보여 주고, 판정은 사람이 단추를 눌러 확정합니다.
 * - index.html 의 Content-Security-Policy(connect-src) 도 api.openai.com 밖으로의 연결을 막습니다.
 */
(function (root) {
  'use strict';
  var ENDPOINT = 'https://api.openai.com/v1/chat/completions';

  // opts: { offline, key, model, prompt, images: [dataUrl…] } → Promise(답 글자)
  function judgePhotos(opts) {
    if (opts.offline !== false) return Promise.reject(new Error('폐쇄망 모드가 켜져 있어 보내지 않았습니다.'));
    if (!opts.key) return Promise.reject(new Error('OpenAI API 키를 「설정·데이터」에 넣어 주세요.'));
    var content = [{ type: 'text', text: opts.prompt }];
    (opts.images || []).forEach(function (u) { content.push({ type: 'image_url', image_url: { url: u, detail: 'high' } }); });
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.key },
      body: JSON.stringify({ model: opts.model || 'gpt-4o-mini', temperature: 0, messages: [{ role: 'user', content: content }] })
    }).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok) throw new Error((j && j.error && j.error.message) || ('HTTP ' + res.status));
        return j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content || '' : '';
      });
    });
  }

  root.WAI = { judgePhotos: judgePhotos, ENDPOINT: ENDPOINT };
})(window);
