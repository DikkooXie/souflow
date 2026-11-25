export function createDocumentMarkdown(MarkdownIt) {
  const markdown = new MarkdownIt({ html: false, breaks: true }).disable("image");
  const validateLink = markdown.validateLink.bind(markdown);
  // 文档内容来自模型和用户。禁止主动加载远端资源，并限制可点开的链接协议。
  markdown.validateLink = url => validateLink(url)
    && (!/^[a-z][a-z\d+.-]*:/i.test(url) || /^(https?|mailto):/i.test(url));
  return text => markdown.render(text);
}
