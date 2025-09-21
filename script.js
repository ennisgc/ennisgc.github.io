document.addEventListener('DOMContentLoaded', function() {
    // Create text size control buttons
    function createTextSizeControls() {
        const offcanvasHeader = document.querySelector('#lyricsOffcanvas .offcanvas-header');
        
        if (offcanvasHeader && !document.querySelector('.text-size-controls')) {
            // Create container for text size controls
            const controlsContainer = document.createElement('div');
            controlsContainer.className = 'text-size-controls d-flex align-items-center me-3';
            
            // Create decrease button
            const decreaseBtn = document.createElement('button');
            decreaseBtn.className = 'btn btn-outline-secondary btn-sm me-2';
            decreaseBtn.innerHTML = 'A-';
            decreaseBtn.title = 'Decrease text size';
            decreaseBtn.setAttribute('aria-label', 'Decrease text size');
            
            // Create increase button
            const increaseBtn = document.createElement('button');
            increaseBtn.className = 'btn btn-outline-secondary btn-sm me-2';
            increaseBtn.innerHTML = 'A+';
            increaseBtn.title = 'Increase text size';
            increaseBtn.setAttribute('aria-label', 'Increase text size');
            
            // Create reset button
            const resetBtn = document.createElement('button');
            resetBtn.className = 'btn btn-outline-secondary btn-sm';
            resetBtn.innerHTML = 'Reset';
            resetBtn.title = 'Reset text size';
            resetBtn.setAttribute('aria-label', 'Reset text size');
            
            // Add buttons to container
            controlsContainer.appendChild(increaseBtn);
            controlsContainer.appendChild(decreaseBtn);
            controlsContainer.appendChild(resetBtn);
            
            // Insert before the close button
            const closeBtn = offcanvasHeader.querySelector('.btn-close');
            offcanvasHeader.insertBefore(controlsContainer, closeBtn);
            
            // Get the lyrics text element
            const lyricsText = document.querySelector('#lyricsOffcanvas pre');
            
            // Default size is always 1.2rem
            const defaultSize = 1.2;
            let currentSize;
            
            // Update button states based on current size
            function updateButtonStates() {
                decreaseBtn.disabled = currentSize <= 0.6;
                increaseBtn.disabled = currentSize >= 2.5;
            }
            
            // Function to update font size
            function updateFontSize(newSize) {
                if (lyricsText) {
                    lyricsText.style.fontSize = newSize + 'rem';
                    currentSize = newSize;
                    
                    // Update button states
                    updateButtonStates();
                    
                    // Always store in localStorage when changed by user
                    localStorage.setItem('lyricsTextSize', newSize);
                }
            }
            
            // Check if there's a saved size in localStorage
            const savedSize = localStorage.getItem('lyricsTextSize');
            if (savedSize) {
                // Use saved size
                currentSize = parseFloat(savedSize);
            } else {
                // Use default size (1.2rem)
                currentSize = defaultSize;
            }
            
            // Always apply the determined size
            if (lyricsText) {
                lyricsText.style.fontSize = currentSize + 'rem';
            }
            updateButtonStates();
            
            // Event listeners
            decreaseBtn.addEventListener('click', function() {
                if (currentSize > 0.6) { // Minimum size (0.6rem)
                    updateFontSize(Math.round((currentSize - 0.1) * 10) / 10); // Round to 1 decimal
                }
            });
            
            increaseBtn.addEventListener('click', function() {
                if (currentSize < 2.5) { // Maximum size (2.5rem)
                    updateFontSize(Math.round((currentSize + 0.1) * 10) / 10); // Round to 1 decimal
                }
            });
            
            resetBtn.addEventListener('click', function() {
                updateFontSize(defaultSize); // Reset to default (1.2rem)
            });
        }
    }
    
    // Initialize controls when offcanvas is shown
    const lyricsOffcanvas = document.getElementById('lyricsOffcanvas');
    if (lyricsOffcanvas) {
        lyricsOffcanvas.addEventListener('shown.bs.offcanvas', createTextSizeControls);
        
        // Also create on page load if offcanvas is already visible
        createTextSizeControls();
    }
});
