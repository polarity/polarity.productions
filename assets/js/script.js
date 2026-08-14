document.addEventListener('DOMContentLoaded', () => {
    const cardVideos = [...document.querySelectorAll('.card-video')]

    if (!cardVideos.length) return

    const playVideo = (video) => {
        video.play().catch(() => {})
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            const video = entry.target
            video.dataset.inView = entry.isIntersecting ? 'true' : 'false'

            if (entry.isIntersecting && !document.hidden) {
                playVideo(video)
            } else {
                video.pause()
            }
        })
    }, {
        rootMargin: '80px 0px',
        threshold: 0.2
    })

    cardVideos.forEach((video) => observer.observe(video))

    document.addEventListener('visibilitychange', () => {
        cardVideos.forEach((video) => {
            if (document.hidden) {
                video.pause()
            } else if (video.dataset.inView === 'true') {
                playVideo(video)
            }
        })
    })
})
