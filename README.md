# 간단 영상 편집기

브라우저에서 바로 쓰는 컷 편집 툴입니다. 서버 없이 정적 파일(`index.html`, `style.css`, `app.js`)만으로 동작하며, 영상은 업로드되지 않고 브라우저 안에서만 처리됩니다.

## 기능
- 영상 불러오기(버튼/드래그 앤 드롭)
- 타임라인: 분할(S), 컷 삭제(Del), 양끝 드래그 트림, 컷 순서 변경, 확대/축소, 실행취소(Ctrl+Z)
- **통 프리뷰**(컷을 이어서 재생) / **컷 프리뷰**(선택한 컷만 반복 재생)
- 내보내기: **WebCodecs**로 프레임 단위 인코딩 후 `edited.mp4` 저장 (실시간보다 빠름, 오디오 포함)

## 사용
`index.html`을 열거나 GitHub Pages 주소로 접속하세요. (Chrome/Edge/Firefox 최신 버전 권장)

## GitHub Pages 배포 (1회 설정)
1. 저장소 **Settings → Pages → Source** 를 **GitHub Actions** 로 선택
2. `main` 브랜치에 푸시되면 자동 배포됩니다 → `https://<계정>.github.io/videoeditool/`

## 한계
- 내보내기는 30fps, 원본 해상도(짝수로 보정)로 재인코딩합니다. 영상은 H.264(미지원 시 VP9), 오디오는 AAC(미지원 시 Opus)입니다.
- WebCodecs를 쓸 수 없는 브라우저에서는 실시간 녹화 방식(MediaRecorder)으로 자동 대체되며, 이때는 결과물 길이만큼 시간이 걸립니다.
- 소리는 파일 전체를 메모리에 디코딩하므로 매우 큰 파일(수 GB)에는 적합하지 않습니다.
- 브라우저가 코덱을 지원해야 재생됩니다(예: 일부 환경에서 아이폰 HEVC 불가).

## 서드파티
`vendor/mp4-muxer.mjs` — [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.1.3 (MIT, `vendor/mp4-muxer.LICENSE`)
